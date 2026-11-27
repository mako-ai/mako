/**
 * 5-stage workspace-scoped dual-run `AppsMetadataRepository` powered by
 * `MigrationRouter` (`domain = "apps_metadata"`).
 *
 * Key guarantees:
 *   - Secret redaction in `shadow-compare`: `env`, `valueEncrypted`,
 *     `passwordHash`, `passwordEncrypted`, `publicSharePasswordHash`,
 *     `publicSharePasswordEncrypted` are hashed only, NEVER logged in diffs.
 *   - Off-critical-path Stage 3/4 shadow-compare resolves legacy 15-char Lucia
 *     user IDs via a single batch PG `users` query ONLY when a read is sampled
 *     (zero extra PG queries in `mongo_only`, `dual_write_mongo_read`, unsampled
 *     reads, or `pg_only`) and strips dual-write `createdAt`/`updatedAt` jitter.
 *   - Per-workspace Stage 4/5 canary safe: global scans, share-token lookups,
 *     and workspace-less binding/project operations partition across PG canary
 *     overrides in `migration_domain_state` when global mode still reads Mongo.
 *   - Delete tombstones recorded in Stages 2 & 3 ONLY for actually-deleted IDs
 *     (`app_projects`, `app_index`, `app_embeddings`, `app_binding_drafts`,
 *     `app_binding_jobs`) so in-flight backfills cannot resurrect deleted rows.
 *   - Mints ONE bijective dual ID (`newDualId()`) per newly created record so
 *     Mongo `_id` and PG `id` match 1:1.
 *   - `app_binding_drafts` and `app_binding_jobs` are pruned by app code
 *     AFTER GCS/artifact parquet blob cleanup (NEVER blind TTL-reaped!).
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { isPersonActorId } from "../../apps/actor-id";
import {
  getPgDb,
  hasPostgresConfig,
  type MakoPgDb,
} from "../../database/pg/client";
import {
  isUuidString,
  newDualId,
  parseEntityId,
  toWireId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import {
  GLOBAL_SCOPE_KEY,
  migrationDomainState,
} from "../../database/pg/schema/control-plane";
import type { IAppDeployProgress } from "../../database/workspace-schema";
import {
  isMigrationForceMongoOnly,
  migrationRouter,
  recordMigrationTombstone,
  type MigrationRouter,
  type RouterOperationContext,
} from "../../migration/router";
import type { ShadowCompareOptions } from "../../migration/types";
import { canonicalizeProjectForShadow } from "./mapper";
import { MongoAppsMetadataRepository } from "./mongo.repo";
import { PgAppsMetadataRepository } from "./pg.repo";
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
  AppIndexScheduleJson,
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

export const APPS_METADATA_DOMAIN = "apps_metadata" as const;

export const APPS_METADATA_SHADOW_OPTIONS: ShadowCompareOptions = {
  redactKeys: [
    "env",
    "valueEncrypted",
    "passwordHash",
    "passwordEncrypted",
    "publicSharePasswordHash",
    "publicSharePasswordEncrypted",
  ],
};

function resolveFkUserForShadow(
  raw: string | undefined,
  userMap: ReadonlyMap<string, string>,
): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mapped = userMap.get(trimmed);
  if (mapped) return mapped;
  return isUuidString(trimmed) ? trimmed.toLowerCase() : undefined;
}

function rewriteTextUserForShadow(
  raw: string,
  userMap: ReadonlyMap<string, string>,
): string {
  const trimmed = raw.trim();
  const mapped = userMap.get(trimmed);
  if (mapped) return mapped;
  return isUuidString(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function collectProjectRawUserIds(
  rec: AppProjectRecord | null,
): Array<string | undefined> {
  if (!rec) return [];
  const out: Array<string | undefined> = [
    rec.owner_id,
    rec.createdBy,
    rec.publicShare?.createdBy,
  ];
  for (const s of rec.sharedWith ?? []) {
    out.push(s.userId, s.addedBy);
  }
  return out;
}

function canonicalizeProjectWithUsers(
  rec: AppProjectRecord | null,
  userMap: ReadonlyMap<string, string>,
): Record<string, unknown> | null {
  if (!rec) return null;
  const ownerId = resolveFkUserForShadow(rec.owner_id, userMap);
  const createdBy = resolveFkUserForShadow(rec.createdBy, userMap) ?? "";
  const rewritten: AppProjectRecord = {
    ...rec,
    createdBy,
    ...(rec.sharedWith !== undefined
      ? {
          sharedWith: rec.sharedWith.map(s => ({
            ...s,
            userId: rewriteTextUserForShadow(s.userId, userMap),
            ...(s.addedBy
              ? { addedBy: rewriteTextUserForShadow(s.addedBy, userMap) }
              : {}),
          })),
        }
      : {}),
    ...(rec.publicShare
      ? {
          publicShare: {
            ...rec.publicShare,
            createdBy: resolveFkUserForShadow(
              rec.publicShare.createdBy,
              userMap,
            ),
          },
        }
      : {}),
  };
  if (ownerId) {
    rewritten.owner_id = ownerId;
  } else {
    delete rewritten.owner_id;
  }
  if (rewritten.publicShare && !rewritten.publicShare.createdBy) {
    delete rewritten.publicShare.createdBy;
  }
  return canonicalizeProjectForShadow(rewritten);
}

function canonicalizeIndexEntryForShadow(
  rec: AppIndexEntryRecord | null,
  userMap: ReadonlyMap<string, string>,
): Record<string, unknown> | null {
  if (!rec) return null;
  const { createdAt: _c, updatedAt: _u, ...rest } = rec;
  const ownerId = resolveFkUserForShadow(rest.ownerId, userMap);
  const out: Record<string, unknown> = { ...rest };
  if (ownerId) {
    out.ownerId = ownerId;
  } else {
    delete out.ownerId;
  }
  return out;
}

function canonicalizeIndexHeadForShadow(
  rec: AppIndexHeadRecord | null,
): Record<string, unknown> | null {
  if (!rec) return null;
  const { createdAt: _c, updatedAt: _u, ...rest } = rec;
  return rest;
}

function canonicalizeLifecycleForShadow(
  rec: AppLifecycleRecord,
  userMap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const { createdAt: _c, updatedAt: _u, ...rest } = rec;
  const verifiedBy = resolveFkUserForShadow(rest.verifiedBy, userMap);
  const restoredBy = resolveFkUserForShadow(rest.restoredBy, userMap);
  const out: Record<string, unknown> = { ...rest };
  if (verifiedBy) {
    out.verifiedBy = verifiedBy;
  } else {
    delete out.verifiedBy;
  }
  if (restoredBy) {
    out.restoredBy = restoredBy;
  } else {
    delete out.restoredBy;
  }
  return out;
}

function canonicalizeWorktreeForShadow(
  rec: AppWorktreeRecord | null,
  userMap: ReadonlyMap<string, string>,
): Record<string, unknown> | null {
  if (!rec) return null;
  const { createdAt: _c, updatedAt: _u, ...rest } = rec;
  return {
    ...rest,
    userId: isPersonActorId(rest.userId)
      ? rewriteTextUserForShadow(rest.userId, userMap)
      : rest.userId,
  };
}

function canonicalizeBindingStateForShadow(
  rec: AppBindingStateRecord | null,
): Record<string, unknown> | null {
  if (!rec) return null;
  const { createdAt: _c, updatedAt: _u, ...rest } = rec;
  return rest;
}

function canonicalizeBindingDraftForShadow(
  rec: AppBindingDraftRecord | null,
): Record<string, unknown> | null {
  if (!rec) return null;
  const { createdAt: _c, updatedAt: _u, ...rest } = rec;
  return rest;
}

function canonicalizeBindingJobForShadow(
  rec: AppBindingJobRecord | null,
  userMap: ReadonlyMap<string, string>,
): Record<string, unknown> | null {
  if (!rec) return null;
  const { createdAt: _c, updatedAt: _u, ...rest } = rec;
  const userId = resolveFkUserForShadow(rest.userId, userMap);
  const out: Record<string, unknown> = {
    ...rest,
    actorId: rest.actorId,
  };
  if (userId) {
    out.userId = userId;
  } else {
    delete out.userId;
  }
  return out;
}

export interface DualAppsMetadataRepositoryDeps {
  mongo?: MongoAppsMetadataRepository;
  pg?: PgAppsMetadataRepository;
  router?: MigrationRouter;
  getDb?: () => MakoPgDb;
}

export class DualAppsMetadataRepository implements AppsMetadataRepository {
  readonly mongo: MongoAppsMetadataRepository;
  readonly pg: PgAppsMetadataRepository;
  private readonly router: MigrationRouter;
  private readonly getDb: () => MakoPgDb;
  private readonly hasInjectedDb: boolean;

  constructor(deps: DualAppsMetadataRepositoryDeps = {}) {
    this.mongo = deps.mongo ?? new MongoAppsMetadataRepository();
    this.pg = deps.pg ?? new PgAppsMetadataRepository({ getDb: deps.getDb });
    this.router = deps.router ?? migrationRouter;
    this.getDb = deps.getDb ?? getPgDb;
    this.hasInjectedDb = Boolean(deps.getDb);
  }

  private hasPgDb(): boolean {
    if (isMigrationForceMongoOnly()) return false;
    return this.hasInjectedDb || hasPostgresConfig();
  }

  /**
   * When PG is enabled AND the global `apps_metadata` mode still reads Mongo,
   * return the set of workspace wire IDs with a per-workspace PG-read override
   * (`dual_write_pg_read` or `pg_only`). Returns `null` immediately when PG is
   * disabled, global mode already reads PG, or no canary overrides exist.
   */
  private async getCanaryPgOverridesIfGlobalMongoRead(): Promise<Set<string> | null> {
    if (!this.hasPgDb()) return null;
    const globalState = await this.router.getState(APPS_METADATA_DOMAIN, null);
    if (
      globalState.mode === "dual_write_pg_read" ||
      globalState.mode === "pg_only"
    ) {
      return null;
    }
    const db = this.getDb();
    const rows = await db
      .select({ workspaceId: migrationDomainState.workspaceId })
      .from(migrationDomainState)
      .where(
        and(
          eq(migrationDomainState.domain, APPS_METADATA_DOMAIN),
          ne(migrationDomainState.scopeKey, GLOBAL_SCOPE_KEY),
          inArray(migrationDomainState.mode, ["dual_write_pg_read", "pg_only"]),
        ),
      );
    if (rows.length === 0) return null;
    const out = new Set<string>();
    for (const r of rows) {
      if (r.workspaceId) out.add(toWireId(r.workspaceId));
    }
    return out.size > 0 ? out : null;
  }

  private async resolveCanaryWorkspaceForProject(
    projectId: string,
    workspaceId?: string,
  ): Promise<string | undefined> {
    if (workspaceId) return workspaceId;
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (!pgOverrides) return undefined;
    const pgWs = await this.pg.findProjectWorkspaceId(projectId);
    if (pgWs && pgOverrides.has(pgWs)) return pgWs;
    return undefined;
  }

  private async resolveCanaryWorkspaceForBindingJob(
    jobId: string,
    workspaceId?: string,
  ): Promise<string | undefined> {
    if (workspaceId) return workspaceId;
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (!pgOverrides) return undefined;
    const pgWs = await this.pg.findBindingJobWorkspaceId(jobId);
    if (pgWs && pgOverrides.has(pgWs)) return pgWs;
    return undefined;
  }

  /**
   * Batch-resolve legacy 15-char Lucia user IDs against Postgres `users`.
   * Called strictly OFF the request critical path (inside sampled shadow reads).
   */
  private async resolveShadowUserMap(
    rawIds: readonly (string | null | undefined)[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const toLookup = new Set<string>();
    for (const raw of rawIds) {
      if (!raw) continue;
      const trimmed = raw.trim();
      if (!trimmed || !isPersonActorId(trimmed)) continue;
      if (isUuidString(trimmed)) {
        out.set(trimmed, trimmed.toLowerCase());
      } else {
        toLookup.add(trimmed);
      }
    }
    if (toLookup.size === 0 || !this.hasPgDb()) return out;

    const legacyList = [...toLookup];
    const db = this.getDb();
    const rows = await db
      .select({ id: users.id, legacyId: users.legacyId })
      .from(users)
      .where(inArray(users.legacyId, legacyList));
    for (const row of rows) {
      const uuid = row.id.toLowerCase();
      out.set(uuid, uuid);
      if (row.legacyId) out.set(row.legacyId, uuid);
    }
    return out;
  }

  /**
   * Execute a read whose Stage 3 / Stage 4 shadow comparison needs legacy 15-char
   * Lucia user IDs normalized to PG UUIDv7s. Zero extra PG queries execute on the
   * critical path or on unsampled / `mongo_only` / `pg_only` reads.
   */
  private executeUserResolvedRead<T>(
    ctx: RouterOperationContext,
    handlers: {
      mongo: () => Promise<T>;
      pg: () => Promise<T>;
      collectRawUserIds: (value: T) => Array<string | null | undefined>;
      canonicalize: (value: T, userMap: ReadonlyMap<string, string>) => unknown;
      shadowOptions?: ShadowCompareOptions;
    },
  ): Promise<T> {
    let mongoCaptured = false;
    let mongoValue: T | undefined;
    let pgCaptured = false;
    const shadowUserMap = new Map<string, string>();

    const populateMap = async (val: T) => {
      const resolved = await this.resolveShadowUserMap(
        handlers.collectRawUserIds(val),
      );
      for (const [k, v] of resolved) {
        shadowUserMap.set(k, v);
      }
    };

    return this.router.executeRead(ctx, {
      mongo: async () => {
        const res = await handlers.mongo();
        mongoCaptured = true;
        mongoValue = res;
        if (pgCaptured) {
          await populateMap(res);
        }
        return res;
      },
      pg: async () => {
        const res = await handlers.pg();
        pgCaptured = true;
        if (mongoCaptured && mongoValue !== undefined) {
          await populateMap(mongoValue);
        }
        return res;
      },
      canonicalize: value => handlers.canonicalize(value, shadowUserMap),
      shadowOptions: handlers.shadowOptions ?? APPS_METADATA_SHADOW_OPTIONS,
    });
  }

  private async maybeRecordTombstones(
    tableName: string,
    ids: readonly string[],
    workspaceId?: string | null,
  ): Promise<void> {
    if (ids.length === 0) return;
    const state = await this.router.getState(APPS_METADATA_DOMAIN, workspaceId);
    if (
      state.mode !== "dual_write_mongo_read" &&
      state.mode !== "dual_write_shadow_compare"
    ) {
      return;
    }
    const db = this.getDb();
    for (const id of ids) {
      const parsed = parseEntityId(id);
      if (parsed) {
        await recordMigrationTombstone(tableName, parsed.uuid, db);
      }
    }
  }

  // ── 1. app_projects ──────────────────────────────────────────────────────

  async findProjectById(
    id: string,
    workspaceId?: string,
  ): Promise<AppProjectRecord | null> {
    if (!workspaceId) {
      const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
      if (pgOverrides) {
        const pgRow = await this.pg.findProjectById(id);
        if (pgRow && pgOverrides.has(pgRow.workspaceId)) {
          return pgRow;
        }
        const mongoRow = await this.mongo.findProjectById(id);
        if (mongoRow && pgOverrides.has(mongoRow.workspaceId)) {
          return null;
        }
        return mongoRow;
      }
    }
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "findProjectById",
        workspaceId,
        entityId: id,
      },
      {
        mongo: () => this.mongo.findProjectById(id, workspaceId),
        pg: () => this.pg.findProjectById(id, workspaceId),
        collectRawUserIds: collectProjectRawUserIds,
        canonicalize: canonicalizeProjectWithUsers,
      },
    );
  }

  findProjectByPath(
    workspaceId: string,
    path: string,
  ): Promise<AppProjectRecord | null> {
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "findProjectByPath",
        workspaceId,
      },
      {
        mongo: () => this.mongo.findProjectByPath(workspaceId, path),
        pg: () => this.pg.findProjectByPath(workspaceId, path),
        collectRawUserIds: collectProjectRawUserIds,
        canonicalize: canonicalizeProjectWithUsers,
      },
    );
  }

  findProjectBySlug(
    workspaceId: string,
    slug: string,
  ): Promise<AppProjectRecord | null> {
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "findProjectBySlug",
        workspaceId,
      },
      {
        mongo: () => this.mongo.findProjectBySlug(workspaceId, slug),
        pg: () => this.pg.findProjectBySlug(workspaceId, slug),
        collectRawUserIds: collectProjectRawUserIds,
        canonicalize: canonicalizeProjectWithUsers,
      },
    );
  }

  async findProjectByShareToken(
    token: string,
  ): Promise<AppProjectRecord | null> {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const pgRow = await this.pg.findProjectByShareToken(token);
      if (pgRow && pgOverrides.has(pgRow.workspaceId)) {
        return pgRow;
      }
      const mongoRow = await this.mongo.findProjectByShareToken(token);
      if (mongoRow && pgOverrides.has(mongoRow.workspaceId)) {
        return null;
      }
      return mongoRow;
    }
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "findProjectByShareToken",
      },
      {
        mongo: () => this.mongo.findProjectByShareToken(token),
        pg: () => this.pg.findProjectByShareToken(token),
        collectRawUserIds: collectProjectRawUserIds,
        canonicalize: canonicalizeProjectWithUsers,
      },
    );
  }

  async isShareTokenTaken(token: string, excludeId?: string): Promise<boolean> {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const pgWs = await this.pg.findShareTokenOwnerWorkspaceId(
        token,
        excludeId,
      );
      if (pgWs && pgOverrides.has(pgWs)) {
        return true;
      }
      const mongoWs = await this.mongo.findShareTokenOwnerWorkspaceId(
        token,
        excludeId,
      );
      return Boolean(mongoWs && !pgOverrides.has(mongoWs));
    }
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "isShareTokenTaken",
      },
      {
        mongo: () => this.mongo.isShareTokenTaken(token, excludeId),
        pg: () => this.pg.isShareTokenTaken(token, excludeId),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  projectExistsMatching(params: {
    id: string;
    workspaceId: string;
    path: string;
    slug: string;
  }): Promise<boolean> {
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "projectExistsMatching",
        workspaceId: params.workspaceId,
        entityId: params.id,
      },
      {
        mongo: () => this.mongo.projectExistsMatching(params),
        pg: () => this.pg.projectExistsMatching(params),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  listProjectsByWorkspace(workspaceId: string): Promise<AppProjectRecord[]> {
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listProjectsByWorkspace",
        workspaceId,
      },
      {
        mongo: () => this.mongo.listProjectsByWorkspace(workspaceId),
        pg: () => this.pg.listProjectsByWorkspace(workspaceId),
        collectRawUserIds: rows => rows.flatMap(collectProjectRawUserIds),
        canonicalize: (rows, userMap) =>
          [...rows]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(row => canonicalizeProjectWithUsers(row, userMap)),
      },
    );
  }

  listProjectsByIds(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<AppProjectRecord[]> {
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listProjectsByIds",
        workspaceId,
      },
      {
        mongo: () => this.mongo.listProjectsByIds(workspaceId, ids),
        pg: () => this.pg.listProjectsByIds(workspaceId, ids),
        collectRawUserIds: rows => rows.flatMap(collectProjectRawUserIds),
        canonicalize: (rows, userMap) =>
          [...rows]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(row => canonicalizeProjectWithUsers(row, userMap)),
      },
    );
  }

  listForeignProjectIds(
    excludeWorkspaceId: string,
    candidateIds: readonly string[],
  ): Promise<string[]> {
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listForeignProjectIds",
        workspaceId: excludeWorkspaceId,
      },
      {
        mongo: () =>
          this.mongo.listForeignProjectIds(excludeWorkspaceId, candidateIds),
        pg: () =>
          this.pg.listForeignProjectIds(excludeWorkspaceId, candidateIds),
        canonicalize: rows => [...rows].sort(),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async listExistingProjectIds(ids: readonly string[]): Promise<string[]> {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const [mongoRows, pgRows] = await Promise.all([
        this.mongo.listExistingProjectIdWorkspaces(ids),
        this.pg.listExistingProjectIdWorkspaces(ids),
      ]);
      const out = new Set<string>();
      for (const r of mongoRows) {
        if (!pgOverrides.has(r.workspaceId)) out.add(r.id);
      }
      for (const r of pgRows) {
        if (pgOverrides.has(r.workspaceId)) out.add(r.id);
      }
      return [...out];
    }
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listExistingProjectIds",
      },
      {
        mongo: () => this.mongo.listExistingProjectIds(ids),
        pg: () => this.pg.listExistingProjectIds(ids),
        canonicalize: rows => [...rows].sort(),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async listDistinctProjectWorkspaceIds(): Promise<string[]> {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const [mongoIds, pgIds] = await Promise.all([
        this.mongo.listDistinctProjectWorkspaceIds(),
        this.pg.listDistinctProjectWorkspaceIds(),
      ]);
      const out = new Set<string>();
      for (const ws of mongoIds) {
        if (!pgOverrides.has(ws)) out.add(ws);
      }
      for (const ws of pgIds) {
        if (pgOverrides.has(ws)) out.add(ws);
      }
      return [...out];
    }
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listDistinctProjectWorkspaceIds",
      },
      {
        mongo: () => this.mongo.listDistinctProjectWorkspaceIds(),
        pg: () => this.pg.listDistinctProjectWorkspaceIds(),
        canonicalize: rows => [...rows].sort(),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async listPublishedProjects(): Promise<AppProjectRecord[]> {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const [mongoRows, pgRows] = await Promise.all([
        this.mongo.listPublishedProjects(),
        this.pg.listPublishedProjects(),
      ]);
      return [
        ...mongoRows.filter(r => !pgOverrides.has(r.workspaceId)),
        ...pgRows.filter(r => pgOverrides.has(r.workspaceId)),
      ];
    }
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listPublishedProjects",
      },
      {
        mongo: () => this.mongo.listPublishedProjects(),
        pg: () => this.pg.listPublishedProjects(),
        collectRawUserIds: rows => rows.flatMap(collectProjectRawUserIds),
        canonicalize: (rows, userMap) =>
          [...rows]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(row => canonicalizeProjectWithUsers(row, userMap)),
      },
    );
  }

  async listOwnerlessProjects(
    workspaceId?: string,
  ): Promise<AppProjectRecord[]> {
    if (!workspaceId) {
      const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
      if (pgOverrides) {
        const [mongoRows, pgRows] = await Promise.all([
          this.mongo.listOwnerlessProjects(),
          this.pg.listOwnerlessProjects(),
        ]);
        return [
          ...mongoRows.filter(r => !pgOverrides.has(r.workspaceId)),
          ...pgRows.filter(r => pgOverrides.has(r.workspaceId)),
        ];
      }
    }
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listOwnerlessProjects",
        workspaceId,
      },
      {
        mongo: () => this.mongo.listOwnerlessProjects(workspaceId),
        pg: () => this.pg.listOwnerlessProjects(workspaceId),
        collectRawUserIds: rows => rows.flatMap(collectProjectRawUserIds),
        canonicalize: (rows, userMap) =>
          [...rows]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(row => canonicalizeProjectWithUsers(row, userMap)),
      },
    );
  }

  createProject(input: CreateAppProjectInput): Promise<AppProjectRecord> {
    const id = input.id ?? newDualId().oid;
    const withId: CreateAppProjectInput = { ...input, id };
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "createProject",
        workspaceId: input.workspaceId,
        entityId: id,
        retryPayload: {
          table: "app_projects",
          id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.createProject(withId),
        pg: () => this.pg.createProject(withId),
      },
    );
  }

  claimOwnerlessProjectRow(
    workspaceId: string,
    id: string,
    ownerId: string,
  ): Promise<boolean> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "claimOwnerlessProjectRow",
        workspaceId,
        entityId: id,
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () =>
          this.mongo.claimOwnerlessProjectRow(workspaceId, id, ownerId),
        pg: () => this.pg.claimOwnerlessProjectRow(workspaceId, id, ownerId),
      },
    );
  }

  updateProjectSharing(
    workspaceId: string,
    id: string,
    patch: UpdateAppProjectSharingPatch,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "updateProjectSharing",
        workspaceId,
        entityId: id,
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () => this.mongo.updateProjectSharing(workspaceId, id, patch),
        pg: () => this.pg.updateProjectSharing(workspaceId, id, patch),
      },
    );
  }

  updateProjectEnv(
    workspaceId: string,
    id: string,
    env: AppEnvVarJson[],
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "updateProjectEnv",
        workspaceId,
        entityId: id,
        // Never put env values into retry payloads: replay fetches authoritative row.
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () => this.mongo.updateProjectEnv(workspaceId, id, env),
        pg: () => this.pg.updateProjectEnv(workspaceId, id, env),
      },
    );
  }

  updateProjectLocation(
    workspaceId: string,
    id: string,
    patch: UpdateAppProjectLocationPatch,
    expectedPath?: string,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "updateProjectLocation",
        workspaceId,
        entityId: id,
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () =>
          this.mongo.updateProjectLocation(
            workspaceId,
            id,
            patch,
            expectedPath,
          ),
        pg: () =>
          this.pg.updateProjectLocation(workspaceId, id, patch, expectedPath),
      },
    );
  }

  unsetProjectsPath(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "unsetProjectsPath",
        workspaceId,
        entityId: ids[0],
        retryPayload: { table: "app_projects", ids: [...ids], workspaceId },
      },
      {
        mongo: () => this.mongo.unsetProjectsPath(workspaceId, ids),
        pg: () => this.pg.unsetProjectsPath(workspaceId, ids),
      },
    );
  }

  syncMovedProjects(
    workspaceId: string,
    updates: readonly ProjectMoveSyncUpdate[],
  ): Promise<void> {
    if (updates.length === 0) return Promise.resolve();
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "syncMovedProjects",
        workspaceId,
        entityId: updates[0].appId,
        retryPayload: {
          table: "app_projects",
          ids: updates.map(u => u.appId),
          workspaceId,
        },
      },
      {
        mongo: () => this.mongo.syncMovedProjects(workspaceId, updates),
        pg: () => this.pg.syncMovedProjects(workspaceId, updates),
      },
    );
  }

  setDeployProgressQueued(
    workspaceId: string,
    id: string,
    progress: IAppDeployProgress,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "setDeployProgressQueued",
        workspaceId,
        entityId: id,
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () =>
          this.mongo.setDeployProgressQueued(workspaceId, id, progress),
        pg: () => this.pg.setDeployProgressQueued(workspaceId, id, progress),
      },
    );
  }

  advanceDeployProgressStage(
    workspaceId: string,
    id: string,
    sha: string,
    stage: AppDeployStage,
    now: Date,
    staleBefore: Date,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "advanceDeployProgressStage",
        workspaceId,
        entityId: id,
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () =>
          this.mongo.advanceDeployProgressStage(
            workspaceId,
            id,
            sha,
            stage,
            now,
            staleBefore,
          ),
        pg: () =>
          this.pg.advanceDeployProgressStage(
            workspaceId,
            id,
            sha,
            stage,
            now,
            staleBefore,
          ),
      },
    );
  }

  updateDeployProgressBindings(
    workspaceId: string,
    id: string,
    sha: string,
    bindings: NonNullable<IAppDeployProgress["bindings"]>,
    now: Date,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "updateDeployProgressBindings",
        workspaceId,
        entityId: id,
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () =>
          this.mongo.updateDeployProgressBindings(
            workspaceId,
            id,
            sha,
            bindings,
            now,
          ),
        pg: () =>
          this.pg.updateDeployProgressBindings(
            workspaceId,
            id,
            sha,
            bindings,
            now,
          ),
      },
    );
  }

  clearDeployProgress(
    workspaceId: string,
    id: string,
    sha: string,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "clearDeployProgress",
        workspaceId,
        entityId: id,
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () => this.mongo.clearDeployProgress(workspaceId, id, sha),
        pg: () => this.pg.clearDeployProgress(workspaceId, id, sha),
      },
    );
  }

  setPublishedSha(
    workspaceId: string,
    id: string,
    sha: string,
    publishedAt: Date,
    expectedSha?: string | null,
  ): Promise<{ matched: boolean }> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "setPublishedSha",
        workspaceId,
        entityId: id,
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () =>
          this.mongo.setPublishedSha(
            workspaceId,
            id,
            sha,
            publishedAt,
            expectedSha,
          ),
        pg: () =>
          this.pg.setPublishedSha(
            workspaceId,
            id,
            sha,
            publishedAt,
            expectedSha,
          ),
      },
    );
  }

  clearPublishedSha(workspaceId: string, id: string): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "clearPublishedSha",
        workspaceId,
        entityId: id,
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () => this.mongo.clearPublishedSha(workspaceId, id),
        pg: () => this.pg.clearPublishedSha(workspaceId, id),
      },
    );
  }

  setLastDeployError(
    workspaceId: string,
    id: string,
    error: AppLastDeployErrorRecord,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "setLastDeployError",
        workspaceId,
        entityId: id,
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () => this.mongo.setLastDeployError(workspaceId, id, error),
        pg: () => this.pg.setLastDeployError(workspaceId, id, error),
      },
    );
  }

  clearLastDeployErrorIfSha(
    workspaceId: string,
    id: string,
    failedSha: string,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "clearLastDeployErrorIfSha",
        workspaceId,
        entityId: id,
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () =>
          this.mongo.clearLastDeployErrorIfSha(workspaceId, id, failedSha),
        pg: () => this.pg.clearLastDeployErrorIfSha(workspaceId, id, failedSha),
      },
    );
  }

  setBindingRefreshError(
    workspaceId: string,
    id: string,
    binding: string,
    error: AppBindingRefreshErrorRecord,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "setBindingRefreshError",
        workspaceId,
        entityId: id,
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () =>
          this.mongo.setBindingRefreshError(workspaceId, id, binding, error),
        pg: () =>
          this.pg.setBindingRefreshError(workspaceId, id, binding, error),
      },
    );
  }

  clearBindingRefreshError(
    workspaceId: string,
    id: string,
    binding: string,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "clearBindingRefreshError",
        workspaceId,
        entityId: id,
        retryPayload: { table: "app_projects", id, workspaceId },
      },
      {
        mongo: () =>
          this.mongo.clearBindingRefreshError(workspaceId, id, binding),
        pg: () => this.pg.clearBindingRefreshError(workspaceId, id, binding),
      },
    );
  }

  async deleteProject(workspaceId: string, id: string): Promise<void> {
    let mongoDeleted = false;
    await this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "deleteProject",
        workspaceId,
        entityId: id,
        retryPayload: {
          table: "app_projects",
          id,
          workspaceId,
          deleted: true,
        },
      },
      {
        mongo: async () => {
          mongoDeleted = await this.mongo.deleteProjectIfPresent(
            workspaceId,
            id,
          );
        },
        pg: () => this.pg.deleteProject(workspaceId, id),
      },
    );
    if (mongoDeleted) {
      await this.maybeRecordTombstones("app_projects", [id], workspaceId);
    }
  }

  async deleteProjectsByWorkspace(workspaceId: string): Promise<number> {
    const existing = await this.listProjectsByWorkspace(workspaceId);
    const count = await this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "deleteProjectsByWorkspace",
        workspaceId,
        entityId: workspaceId,
        retryPayload: {
          table: "app_projects",
          workspaceId,
          deletedWorkspace: true,
        },
      },
      {
        mongo: () => this.mongo.deleteProjectsByWorkspace(workspaceId),
        pg: () => this.pg.deleteProjectsByWorkspace(workspaceId),
      },
    );
    if (count > 0 && existing.length > 0) {
      await this.maybeRecordTombstones(
        "app_projects",
        existing.map(p => p.id),
        workspaceId,
      );
    }
    return count;
  }

  // ── 2. app_index ─────────────────────────────────────────────────────────

  listIndexEntriesByWorkspace(
    workspaceId: string,
  ): Promise<AppIndexEntryRecord[]> {
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listIndexEntriesByWorkspace",
        workspaceId,
      },
      {
        mongo: () => this.mongo.listIndexEntriesByWorkspace(workspaceId),
        pg: () => this.pg.listIndexEntriesByWorkspace(workspaceId),
        collectRawUserIds: rows => rows.map(r => r.ownerId),
        canonicalize: (rows, userMap) =>
          [...rows]
            .sort((a, b) => a.appId.localeCompare(b.appId))
            .map(row => canonicalizeIndexEntryForShadow(row, userMap)),
      },
    );
  }

  async findIndexEntryByAppId(
    appId: string,
    workspaceId?: string,
  ): Promise<AppIndexEntryRecord | null> {
    if (!workspaceId) {
      const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
      if (pgOverrides) {
        const pgRow = await this.pg.findIndexEntryByAppId(appId);
        if (pgRow && pgOverrides.has(pgRow.workspaceId)) {
          return pgRow;
        }
        const mongoRow = await this.mongo.findIndexEntryByAppId(appId);
        if (mongoRow && pgOverrides.has(mongoRow.workspaceId)) {
          return null;
        }
        return mongoRow;
      }
    }
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "findIndexEntryByAppId",
        workspaceId,
        entityId: appId,
      },
      {
        mongo: () => this.mongo.findIndexEntryByAppId(appId, workspaceId),
        pg: () => this.pg.findIndexEntryByAppId(appId, workspaceId),
        collectRawUserIds: row => (row ? [row.ownerId] : []),
        canonicalize: canonicalizeIndexEntryForShadow,
      },
    );
  }

  async indexEntryExistsByAppId(appId: string): Promise<boolean> {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const pgRow = await this.pg.findIndexEntryByAppId(appId);
      if (pgRow && pgOverrides.has(pgRow.workspaceId)) {
        return true;
      }
      const mongoRow = await this.mongo.findIndexEntryByAppId(appId);
      return Boolean(mongoRow && !pgOverrides.has(mongoRow.workspaceId));
    }
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "indexEntryExistsByAppId",
        entityId: appId,
      },
      {
        mongo: () => this.mongo.indexEntryExistsByAppId(appId),
        pg: () => this.pg.indexEntryExistsByAppId(appId),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async listIndexEntriesBySlugAndScope(
    slug: string,
    scope: AppAccessScope,
    limit: number,
  ): Promise<Array<{ workspaceId: string; appId: string }>> {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const [mongoRows, pgRows] = await Promise.all([
        this.mongo.listIndexEntriesBySlugAndScope(slug, scope, limit),
        this.pg.listIndexEntriesBySlugAndScope(slug, scope, limit),
      ]);
      return [
        ...mongoRows.filter(r => !pgOverrides.has(r.workspaceId)),
        ...pgRows.filter(r => pgOverrides.has(r.workspaceId)),
      ].slice(0, limit);
    }
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listIndexEntriesBySlugAndScope",
      },
      {
        mongo: () =>
          this.mongo.listIndexEntriesBySlugAndScope(slug, scope, limit),
        pg: () => this.pg.listIndexEntriesBySlugAndScope(slug, scope, limit),
        canonicalize: rows =>
          [...rows].sort((a, b) => a.appId.localeCompare(b.appId)),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async listIndexEntriesWithSchedules(): Promise<
    Array<{
      workspaceId: string;
      appId: string;
      schedules: AppIndexScheduleJson[];
    }>
  > {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const [mongoRows, pgRows] = await Promise.all([
        this.mongo.listIndexEntriesWithSchedules(),
        this.pg.listIndexEntriesWithSchedules(),
      ]);
      return [
        ...mongoRows.filter(r => !pgOverrides.has(r.workspaceId)),
        ...pgRows.filter(r => pgOverrides.has(r.workspaceId)),
      ];
    }
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listIndexEntriesWithSchedules",
      },
      {
        mongo: () => this.mongo.listIndexEntriesWithSchedules(),
        pg: () => this.pg.listIndexEntriesWithSchedules(),
        canonicalize: rows =>
          [...rows].sort((a, b) => a.appId.localeCompare(b.appId)),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async listIndexEntriesByAppIds(
    appIds: readonly string[],
  ): Promise<Array<{ workspaceId: string; appId: string; path: string }>> {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const [mongoRows, pgRows] = await Promise.all([
        this.mongo.listIndexEntriesByAppIds(appIds),
        this.pg.listIndexEntriesByAppIds(appIds),
      ]);
      return [
        ...mongoRows.filter(r => !pgOverrides.has(r.workspaceId)),
        ...pgRows.filter(r => pgOverrides.has(r.workspaceId)),
      ];
    }
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listIndexEntriesByAppIds",
      },
      {
        mongo: () => this.mongo.listIndexEntriesByAppIds(appIds),
        pg: () => this.pg.listIndexEntriesByAppIds(appIds),
        canonicalize: rows =>
          [...rows].sort((a, b) => a.appId.localeCompare(b.appId)),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  listForeignIndexAppIds(
    excludeWorkspaceId: string,
    candidateIds: readonly string[],
  ): Promise<string[]> {
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listForeignIndexAppIds",
        workspaceId: excludeWorkspaceId,
      },
      {
        mongo: () =>
          this.mongo.listForeignIndexAppIds(excludeWorkspaceId, candidateIds),
        pg: () =>
          this.pg.listForeignIndexAppIds(excludeWorkspaceId, candidateIds),
        canonicalize: rows => [...rows].sort(),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async listDistinctWorkspaceIdsWithThumbnails(): Promise<string[]> {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const [mongoIds, pgIds] = await Promise.all([
        this.mongo.listDistinctWorkspaceIdsWithThumbnails(),
        this.pg.listDistinctWorkspaceIdsWithThumbnails(),
      ]);
      const out = new Set<string>();
      for (const ws of mongoIds) {
        if (!pgOverrides.has(ws)) out.add(ws);
      }
      for (const ws of pgIds) {
        if (pgOverrides.has(ws)) out.add(ws);
      }
      return [...out];
    }
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listDistinctWorkspaceIdsWithThumbnails",
      },
      {
        mongo: () => this.mongo.listDistinctWorkspaceIdsWithThumbnails(),
        pg: () => this.pg.listDistinctWorkspaceIdsWithThumbnails(),
        canonicalize: rows => [...rows].sort(),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async listDistinctIndexWorkspaceIds(): Promise<string[]> {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const [mongoIds, pgIds] = await Promise.all([
        this.mongo.listDistinctIndexWorkspaceIds(),
        this.pg.listDistinctIndexWorkspaceIds(),
      ]);
      const out = new Set<string>();
      for (const ws of mongoIds) {
        if (!pgOverrides.has(ws)) out.add(ws);
      }
      for (const ws of pgIds) {
        if (pgOverrides.has(ws)) out.add(ws);
      }
      return [...out];
    }
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listDistinctIndexWorkspaceIds",
      },
      {
        mongo: () => this.mongo.listDistinctIndexWorkspaceIds(),
        pg: () => this.pg.listDistinctIndexWorkspaceIds(),
        canonicalize: rows => [...rows].sort(),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async replaceWorkspaceIndexEntries(
    workspaceId: string,
    staleEntryIds: readonly string[],
    entries: readonly UpsertAppIndexEntryInput[],
  ): Promise<void> {
    const withIds = entries.map(e => ({
      ...e,
      id: e.id ?? newDualId().oid,
    }));
    let deletedIds: string[] = [];
    await this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "replaceWorkspaceIndexEntries",
        workspaceId,
        entityId: workspaceId,
        retryPayload: { table: "app_index", workspaceId },
      },
      {
        mongo: async () => {
          deletedIds =
            await this.mongo.replaceWorkspaceIndexEntriesReturningDeletedIds(
              workspaceId,
              staleEntryIds,
              withIds,
            );
        },
        pg: () =>
          this.pg.replaceWorkspaceIndexEntries(
            workspaceId,
            staleEntryIds,
            withIds,
          ),
        secondaryTimeoutMs: 5_000,
      },
    );
    if (deletedIds.length > 0) {
      await this.maybeRecordTombstones("app_index", deletedIds, workspaceId);
    }
  }

  // ── 3. app_index_heads ───────────────────────────────────────────────────

  findIndexHeadByWorkspace(
    workspaceId: string,
  ): Promise<AppIndexHeadRecord | null> {
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "findIndexHeadByWorkspace",
        workspaceId,
      },
      {
        mongo: () => this.mongo.findIndexHeadByWorkspace(workspaceId),
        pg: () => this.pg.findIndexHeadByWorkspace(workspaceId),
        canonicalize: canonicalizeIndexHeadForShadow,
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  upsertIndexHead(
    workspaceId: string,
    input: { sha: string; schemaVersion: number; folders: string[] },
  ): Promise<void> {
    const id = newDualId().oid;
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "upsertIndexHead",
        workspaceId,
        entityId: workspaceId,
        retryPayload: { table: "app_index_heads", workspaceId },
      },
      {
        mongo: () => this.mongo.upsertIndexHead(workspaceId, { ...input, id }),
        pg: () => this.pg.upsertIndexHead(workspaceId, { ...input, id }),
      },
    );
  }

  // ── 4. app_embeddings ────────────────────────────────────────────────────

  listEmbeddingsMetaByWorkspace(
    workspaceId: string,
  ): Promise<AppEmbeddingMeta[]> {
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listEmbeddingsMetaByWorkspace",
        workspaceId,
      },
      {
        mongo: () => this.mongo.listEmbeddingsMetaByWorkspace(workspaceId),
        pg: () => this.pg.listEmbeddingsMetaByWorkspace(workspaceId),
        canonicalize: rows =>
          [...rows].sort((a, b) => a.appId.localeCompare(b.appId)),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  listEmbeddingsByWorkspaceAndModel(
    workspaceId: string,
    embeddingModel: string,
  ): Promise<AppEmbeddingVectorEntry[]> {
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listEmbeddingsByWorkspaceAndModel",
        workspaceId,
      },
      {
        mongo: () =>
          this.mongo.listEmbeddingsByWorkspaceAndModel(
            workspaceId,
            embeddingModel,
          ),
        pg: () =>
          this.pg.listEmbeddingsByWorkspaceAndModel(
            workspaceId,
            embeddingModel,
          ),
        canonicalize: rows =>
          [...rows].sort((a, b) => a.appId.localeCompare(b.appId)),
        shadowOptions: { ...APPS_METADATA_SHADOW_OPTIONS, floatEpsilon: 1e-5 },
      },
    );
  }

  async deleteEmbeddingsByAppIds(
    workspaceId: string,
    appIds: readonly string[],
  ): Promise<void> {
    if (appIds.length === 0) return;
    let deletedIds: string[] = [];
    await this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "deleteEmbeddingsByAppIds",
        workspaceId,
        entityId: appIds[0],
        retryPayload: {
          table: "app_embeddings",
          workspaceId,
          deletedAppIds: [...appIds],
        },
      },
      {
        mongo: async () => {
          deletedIds = await this.mongo.deleteEmbeddingsByAppIdsReturningIds(
            workspaceId,
            appIds,
          );
        },
        pg: () => this.pg.deleteEmbeddingsByAppIds(workspaceId, appIds),
      },
    );
    if (deletedIds.length > 0) {
      await this.maybeRecordTombstones(
        "app_embeddings",
        deletedIds,
        workspaceId,
      );
    }
  }

  upsertEmbeddingsBatch(
    workspaceId: string,
    fullUpserts: readonly UpsertAppEmbeddingInput[],
    pathOnlyUpdates: readonly AppEmbeddingPathUpdate[],
  ): Promise<void> {
    if (fullUpserts.length === 0 && pathOnlyUpdates.length === 0) {
      return Promise.resolve();
    }
    const withIds = fullUpserts.map(u => ({
      ...u,
      id: u.id ?? newDualId().oid,
    }));
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "upsertEmbeddingsBatch",
        workspaceId,
        entityId: withIds[0]?.appId ?? pathOnlyUpdates[0]?.appId ?? workspaceId,
        retryPayload: { table: "app_embeddings", workspaceId },
      },
      {
        mongo: () =>
          this.mongo.upsertEmbeddingsBatch(
            workspaceId,
            withIds,
            pathOnlyUpdates,
          ),
        pg: () =>
          this.pg.upsertEmbeddingsBatch(workspaceId, withIds, pathOnlyUpdates),
      },
    );
  }

  // ── 5. app_lifecycle ─────────────────────────────────────────────────────

  listLifecycleByWorkspace(workspaceId: string): Promise<AppLifecycleRecord[]> {
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listLifecycleByWorkspace",
        workspaceId,
      },
      {
        mongo: () => this.mongo.listLifecycleByWorkspace(workspaceId),
        pg: () => this.pg.listLifecycleByWorkspace(workspaceId),
        collectRawUserIds: rows =>
          rows.flatMap(r => [r.verifiedBy, r.restoredBy]),
        canonicalize: (rows, userMap) =>
          [...rows]
            .sort((a, b) => a.appId.localeCompare(b.appId))
            .map(row => canonicalizeLifecycleForShadow(row, userMap)),
      },
    );
  }

  listLifecycleByArchivedTo(
    workspaceId: string,
    archivedToPaths: readonly string[],
  ): Promise<Array<{ archivedTo: string; archivedFrom: string }>> {
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listLifecycleByArchivedTo",
        workspaceId,
      },
      {
        mongo: () =>
          this.mongo.listLifecycleByArchivedTo(workspaceId, archivedToPaths),
        pg: () =>
          this.pg.listLifecycleByArchivedTo(workspaceId, archivedToPaths),
        canonicalize: rows =>
          [...rows].sort((a, b) => a.archivedTo.localeCompare(b.archivedTo)),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  listVerifiedAppIds(workspaceId: string): Promise<string[]> {
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listVerifiedAppIds",
        workspaceId,
      },
      {
        mongo: () => this.mongo.listVerifiedAppIds(workspaceId),
        pg: () => this.pg.listVerifiedAppIds(workspaceId),
        canonicalize: rows => [...rows].sort(),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async listPausedScheduleAppIds(): Promise<string[]> {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const [mongoEntries, pgEntries] = await Promise.all([
        this.mongo.listPausedScheduleEntries(),
        this.pg.listPausedScheduleEntries(),
      ]);
      const out = new Set<string>();
      for (const e of mongoEntries) {
        if (!pgOverrides.has(e.workspaceId)) out.add(e.appId);
      }
      for (const e of pgEntries) {
        if (pgOverrides.has(e.workspaceId)) out.add(e.appId);
      }
      return [...out];
    }
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listPausedScheduleAppIds",
      },
      {
        mongo: () => this.mongo.listPausedScheduleAppIds(),
        pg: () => this.pg.listPausedScheduleAppIds(),
        canonicalize: rows => [...rows].sort(),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  clearStaleAndPausedOnOpen(workspaceId: string, appId: string): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "clearStaleAndPausedOnOpen",
        workspaceId,
        entityId: appId,
        retryPayload: { table: "app_lifecycle", workspaceId, appId },
      },
      {
        mongo: () => this.mongo.clearStaleAndPausedOnOpen(workspaceId, appId),
        pg: () => this.pg.clearStaleAndPausedOnOpen(workspaceId, appId),
      },
    );
  }

  markAppRestored(
    workspaceId: string,
    appId: string,
    restoredAt: Date,
    restoredBy?: string,
  ): Promise<void> {
    const id = newDualId().oid;
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "markAppRestored",
        workspaceId,
        entityId: appId,
        retryPayload: { table: "app_lifecycle", workspaceId, appId },
      },
      {
        mongo: () =>
          this.mongo.markAppRestored(
            workspaceId,
            appId,
            restoredAt,
            restoredBy,
            id,
          ),
        pg: () =>
          this.pg.markAppRestored(
            workspaceId,
            appId,
            restoredAt,
            restoredBy,
            id,
          ),
      },
    );
  }

  upsertLifecyclePatch(
    workspaceId: string,
    appId: string,
    patch: AppLifecyclePatch,
  ): Promise<void> {
    const id = newDualId().oid;
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "upsertLifecyclePatch",
        workspaceId,
        entityId: appId,
        retryPayload: { table: "app_lifecycle", workspaceId, appId },
      },
      {
        mongo: () =>
          this.mongo.upsertLifecyclePatch(workspaceId, appId, patch, id),
        pg: () => this.pg.upsertLifecyclePatch(workspaceId, appId, patch, id),
      },
    );
  }

  // ── 6. app_deploy_commit_statuses ────────────────────────────────────────

  listPendingCommitStatusesExcludingSha(
    workspaceId: string,
    appId: string,
    excludeSha: string,
  ): Promise<string[]> {
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listPendingCommitStatusesExcludingSha",
        workspaceId,
        entityId: appId,
      },
      {
        mongo: () =>
          this.mongo.listPendingCommitStatusesExcludingSha(
            workspaceId,
            appId,
            excludeSha,
          ),
        pg: () =>
          this.pg.listPendingCommitStatusesExcludingSha(
            workspaceId,
            appId,
            excludeSha,
          ),
        canonicalize: rows => [...rows].sort(),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  casResolvePendingCommitStatus(
    workspaceId: string,
    appId: string,
    sha: string,
    newState: AppDeployCommitStatePg,
  ): Promise<boolean> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "casResolvePendingCommitStatus",
        workspaceId,
        entityId: `${appId}:${sha}`,
        retryPayload: {
          table: "app_deploy_commit_statuses",
          workspaceId,
          appId,
          sha,
        },
      },
      {
        mongo: () =>
          this.mongo.casResolvePendingCommitStatus(
            workspaceId,
            appId,
            sha,
            newState,
          ),
        pg: () =>
          this.pg.casResolvePendingCommitStatus(
            workspaceId,
            appId,
            sha,
            newState,
          ),
      },
    );
  }

  upsertCommitStatus(
    workspaceId: string,
    appId: string,
    sha: string,
    state: AppDeployCommitStatePg,
  ): Promise<void> {
    const id = newDualId().oid;
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "upsertCommitStatus",
        workspaceId,
        entityId: `${appId}:${sha}`,
        retryPayload: {
          table: "app_deploy_commit_statuses",
          workspaceId,
          appId,
          sha,
        },
      },
      {
        mongo: () =>
          this.mongo.upsertCommitStatus(workspaceId, appId, sha, state, id),
        pg: () =>
          this.pg.upsertCommitStatus(workspaceId, appId, sha, state, id),
      },
    );
  }

  // ── 7. app_worktrees ─────────────────────────────────────────────────────

  findWorktree(
    workspaceId: string,
    actorId: string,
  ): Promise<AppWorktreeRecord | null> {
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "findWorktree",
        workspaceId,
        entityId: actorId,
      },
      {
        mongo: () => this.mongo.findWorktree(workspaceId, actorId),
        pg: () => this.pg.findWorktree(workspaceId, actorId),
        collectRawUserIds: row => (row ? [row.userId] : []),
        canonicalize: canonicalizeWorktreeForShadow,
      },
    );
  }

  ensureWorktreeRow(
    workspaceId: string,
    actorId: string,
    defaultBranch: string,
  ): Promise<AppWorktreeRecord> {
    const id = newDualId().oid;
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "ensureWorktreeRow",
        workspaceId,
        entityId: actorId,
        retryPayload: { table: "app_worktrees", workspaceId, actorId },
      },
      {
        mongo: () =>
          this.mongo.ensureWorktreeRow(workspaceId, actorId, defaultBranch, id),
        pg: () =>
          this.pg.ensureWorktreeRow(workspaceId, actorId, defaultBranch, id),
      },
    );
  }

  updateWorktreeBranch(
    workspaceId: string,
    actorId: string,
    branch: string,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "updateWorktreeBranch",
        workspaceId,
        entityId: actorId,
        retryPayload: { table: "app_worktrees", workspaceId, actorId },
      },
      {
        mongo: () =>
          this.mongo.updateWorktreeBranch(workspaceId, actorId, branch),
        pg: () => this.pg.updateWorktreeBranch(workspaceId, actorId, branch),
      },
    );
  }

  bumpWorktreeActivity(
    workspaceId: string,
    actorId: string,
    lastActivityAt: Date,
    activeUntil?: Date,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "bumpWorktreeActivity",
        workspaceId,
        entityId: actorId,
        retryPayload: { table: "app_worktrees", workspaceId, actorId },
      },
      {
        mongo: () =>
          this.mongo.bumpWorktreeActivity(
            workspaceId,
            actorId,
            lastActivityAt,
            activeUntil,
          ),
        pg: () =>
          this.pg.bumpWorktreeActivity(
            workspaceId,
            actorId,
            lastActivityAt,
            activeUntil,
          ),
      },
    );
  }

  async listWorktreesActivity(
    pairs: ReadonlyArray<{ workspaceId: string; actorId: string }>,
  ): Promise<
    Array<{
      workspaceId: string;
      userId: string;
      lastActivityAt: Date | null;
      activeUntil: Date | null;
    }>
  > {
    if (pairs.length === 0) return [];
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const mongoPairs = pairs.filter(p => !pgOverrides.has(p.workspaceId));
      const pgPairs = pairs.filter(p => pgOverrides.has(p.workspaceId));
      const [mongoRows, pgRows] = await Promise.all([
        mongoPairs.length > 0
          ? this.mongo.listWorktreesActivity(mongoPairs)
          : Promise.resolve([]),
        pgPairs.length > 0
          ? this.pg.listWorktreesActivity(pgPairs)
          : Promise.resolve([]),
      ]);
      return [...mongoRows, ...pgRows];
    }
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listWorktreesActivity",
      },
      {
        mongo: () => this.mongo.listWorktreesActivity(pairs),
        pg: () => this.pg.listWorktreesActivity(pairs),
        collectRawUserIds: rows => rows.map(r => r.userId),
        canonicalize: (rows, userMap) =>
          rows
            .map(row => ({
              ...row,
              userId: isPersonActorId(row.userId)
                ? rewriteTextUserForShadow(row.userId, userMap)
                : row.userId,
            }))
            .sort((a, b) =>
              `${a.workspaceId}:${a.userId}`.localeCompare(
                `${b.workspaceId}:${b.userId}`,
              ),
            ),
      },
    );
  }

  getWorktreePauseHistory(
    workspaceId: string,
    actorId: string,
  ): Promise<{
    pausedAt: Date[];
    holdUntil: Date | null;
    holdSetAt: Date | null;
  }> {
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "getWorktreePauseHistory",
        workspaceId,
        entityId: actorId,
      },
      {
        mongo: () => this.mongo.getWorktreePauseHistory(workspaceId, actorId),
        pg: () => this.pg.getWorktreePauseHistory(workspaceId, actorId),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  recordWorktreePause(
    workspaceId: string,
    actorId: string,
    at: Date,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "recordWorktreePause",
        workspaceId,
        entityId: actorId,
        retryPayload: { table: "app_worktrees", workspaceId, actorId },
      },
      {
        mongo: () => this.mongo.recordWorktreePause(workspaceId, actorId, at),
        pg: () => this.pg.recordWorktreePause(workspaceId, actorId, at),
      },
    );
  }

  holdWorktreePausing(
    workspaceId: string,
    actorId: string,
    until: Date,
    setAt: Date,
  ): Promise<void> {
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "holdWorktreePausing",
        workspaceId,
        entityId: actorId,
        retryPayload: { table: "app_worktrees", workspaceId, actorId },
      },
      {
        mongo: () =>
          this.mongo.holdWorktreePausing(workspaceId, actorId, until, setAt),
        pg: () =>
          this.pg.holdWorktreePausing(workspaceId, actorId, until, setAt),
      },
    );
  }

  async listHotWorktreeWorkspacesSince(
    since: Date,
  ): Promise<HotWorktreeWorkspaceRecord[]> {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const [mongoRows, pgRows] = await Promise.all([
        this.mongo.listHotWorktreeWorkspacesSince(since),
        this.pg.listHotWorktreeWorkspacesSince(since),
      ]);
      return [
        ...mongoRows.filter(r => !pgOverrides.has(r.workspaceId)),
        ...pgRows.filter(r => pgOverrides.has(r.workspaceId)),
      ];
    }
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listHotWorktreeWorkspacesSince",
      },
      {
        mongo: () => this.mongo.listHotWorktreeWorkspacesSince(since),
        pg: () => this.pg.listHotWorktreeWorkspacesSince(since),
        canonicalize: rows =>
          [...rows].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  // ── 8. app_binding_state ─────────────────────────────────────────────────

  async getBindingState(
    projectId: string,
    name: string,
    workspaceId?: string,
  ): Promise<AppBindingStateRecord | null> {
    const effectiveWs = await this.resolveCanaryWorkspaceForProject(
      projectId,
      workspaceId,
    );
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "getBindingState",
        workspaceId: effectiveWs,
        entityId: `${projectId}:${name}`,
      },
      {
        mongo: () => this.mongo.getBindingState(projectId, name),
        pg: () => this.pg.getBindingState(projectId, name, effectiveWs),
        canonicalize: canonicalizeBindingStateForShadow,
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  listBindingStatesByProjects(
    workspaceId: string,
    projectIds: readonly string[],
  ): Promise<BindingStateSummaryRecord[]> {
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listBindingStatesByProjects",
        workspaceId,
      },
      {
        mongo: () =>
          this.mongo.listBindingStatesByProjects(workspaceId, projectIds),
        pg: () => this.pg.listBindingStatesByProjects(workspaceId, projectIds),
        canonicalize: rows =>
          [...rows].sort((a, b) =>
            `${a.projectId}:${a.name}`.localeCompare(
              `${b.projectId}:${b.name}`,
            ),
          ),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async recordBindingRun(
    projectId: string,
    name: string,
    run: AppBindingRunRecord,
    workspaceId?: string,
  ): Promise<void> {
    const effectiveWs = await this.resolveCanaryWorkspaceForProject(
      projectId,
      workspaceId,
    );
    const id = newDualId().oid;
    await this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "recordBindingRun",
        workspaceId: effectiveWs,
        entityId: `${projectId}:${name}`,
        retryPayload: {
          table: "app_binding_state",
          projectId,
          name,
          ...(effectiveWs ? { workspaceId: effectiveWs } : {}),
        },
      },
      {
        mongo: () =>
          this.mongo.recordBindingRun(projectId, name, run, effectiveWs, id),
        pg: () =>
          this.pg.recordBindingRun(projectId, name, run, effectiveWs, id),
      },
    );
  }

  async claimPublicBindingRefresh(
    projectId: string,
    name: string,
    cooldownMs: number,
    now: Date = new Date(),
    workspaceId?: string,
  ): Promise<ClaimPublicBindingRefreshResult> {
    const effectiveWs = await this.resolveCanaryWorkspaceForProject(
      projectId,
      workspaceId,
    );
    const id = newDualId().oid;
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "claimPublicBindingRefresh",
        workspaceId: effectiveWs,
        entityId: `${projectId}:${name}`,
        retryPayload: {
          table: "app_binding_state",
          projectId,
          name,
          ...(effectiveWs ? { workspaceId: effectiveWs } : {}),
        },
      },
      {
        mongo: () =>
          this.mongo.claimPublicBindingRefresh(
            projectId,
            name,
            cooldownMs,
            now,
            effectiveWs,
            id,
          ),
        pg: () =>
          this.pg.claimPublicBindingRefresh(
            projectId,
            name,
            cooldownMs,
            now,
            effectiveWs,
            id,
          ),
      },
    );
  }

  // ── 9. app_binding_drafts ────────────────────────────────────────────────

  async findActiveDraftBuild(
    projectId: string,
    hash: string,
    now: Date,
    workspaceId?: string,
  ): Promise<AppBindingDraftRecord | null> {
    const effectiveWs = await this.resolveCanaryWorkspaceForProject(
      projectId,
      workspaceId,
    );
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "findActiveDraftBuild",
        workspaceId: effectiveWs,
        entityId: `${projectId}:${hash}`,
      },
      {
        mongo: () => this.mongo.findActiveDraftBuild(projectId, hash, now),
        pg: () =>
          this.pg.findActiveDraftBuild(projectId, hash, now, effectiveWs),
        canonicalize: canonicalizeBindingDraftForShadow,
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async findDraftFailure(
    projectId: string,
    hash: string,
    workspaceId?: string,
  ): Promise<AppBindingDraftRecord | null> {
    const effectiveWs = await this.resolveCanaryWorkspaceForProject(
      projectId,
      workspaceId,
    );
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "findDraftFailure",
        workspaceId: effectiveWs,
        entityId: `${projectId}:${hash}`,
      },
      {
        mongo: () => this.mongo.findDraftFailure(projectId, hash),
        pg: () => this.pg.findDraftFailure(projectId, hash, effectiveWs),
        canonicalize: canonicalizeBindingDraftForShadow,
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async createDraftBuild(
    input: CreateBindingDraftBuildInput,
    workspaceId?: string,
  ): Promise<AppBindingDraftRecord> {
    const effectiveWs = await this.resolveCanaryWorkspaceForProject(
      input.projectId,
      workspaceId,
    );
    const id = input.id ?? newDualId().oid;
    const withId: CreateBindingDraftBuildInput = { ...input, id };
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "createDraftBuild",
        workspaceId: effectiveWs,
        entityId: id,
        retryPayload: {
          table: "app_binding_drafts",
          id,
          ...(effectiveWs ? { workspaceId: effectiveWs } : {}),
        },
      },
      {
        mongo: () => this.mongo.createDraftBuild(withId),
        pg: () => this.pg.createDraftBuild(withId, effectiveWs),
      },
    );
  }

  async deleteDraftFailures(
    projectId: string,
    hash: string,
    workspaceId?: string,
  ): Promise<void> {
    const effectiveWs = await this.resolveCanaryWorkspaceForProject(
      projectId,
      workspaceId,
    );
    let deletedIds: string[] = [];
    await this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "deleteDraftFailures",
        workspaceId: effectiveWs,
        entityId: `${projectId}:${hash}`,
        retryPayload: {
          table: "app_binding_drafts",
          projectId,
          hash,
          deletedFailures: true,
          ...(effectiveWs ? { workspaceId: effectiveWs } : {}),
        },
      },
      {
        mongo: async () => {
          deletedIds = await this.mongo.deleteDraftFailuresReturningIds(
            projectId,
            hash,
          );
        },
        pg: () => this.pg.deleteDraftFailures(projectId, hash, effectiveWs),
      },
    );
    if (deletedIds.length > 0) {
      await this.maybeRecordTombstones(
        "app_binding_drafts",
        deletedIds,
        effectiveWs,
      );
    }
  }

  async deleteDraftBuildByKey(
    projectId: string,
    key: string,
    workspaceId?: string,
  ): Promise<void> {
    const effectiveWs = await this.resolveCanaryWorkspaceForProject(
      projectId,
      workspaceId,
    );
    let deletedId: string | null = null;
    await this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "deleteDraftBuildByKey",
        workspaceId: effectiveWs,
        entityId: projectId,
        retryPayload: {
          table: "app_binding_drafts",
          projectId,
          key,
          deletedByKey: true,
          ...(effectiveWs ? { workspaceId: effectiveWs } : {}),
        },
      },
      {
        mongo: async () => {
          deletedId = await this.mongo.deleteDraftBuildByKeyReturningId(
            projectId,
            key,
          );
        },
        pg: () => this.pg.deleteDraftBuildByKey(projectId, key, effectiveWs),
      },
    );
    if (deletedId) {
      await this.maybeRecordTombstones(
        "app_binding_drafts",
        [deletedId],
        effectiveWs,
      );
    }
  }

  async upsertDraftFailure(
    input: UpsertBindingDraftFailureInput,
    workspaceId?: string,
  ): Promise<void> {
    const effectiveWs = await this.resolveCanaryWorkspaceForProject(
      input.projectId,
      workspaceId,
    );
    const id = input.id ?? newDualId().oid;
    const withId: UpsertBindingDraftFailureInput = { ...input, id };
    await this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "upsertDraftFailure",
        workspaceId: effectiveWs,
        entityId: `${input.projectId}:${input.hash}`,
        retryPayload: {
          table: "app_binding_drafts",
          projectId: input.projectId,
          hash: input.hash,
          kind: "failure",
          ...(effectiveWs ? { workspaceId: effectiveWs } : {}),
        },
      },
      {
        mongo: () => this.mongo.upsertDraftFailure(withId),
        pg: () => this.pg.upsertDraftFailure(withId, effectiveWs),
      },
    );
  }

  async listExpiredDrafts(
    projectId: string,
    now: Date,
    limit: number,
    workspaceId?: string,
  ): Promise<Array<{ id: string; key: string | null }>> {
    const effectiveWs = await this.resolveCanaryWorkspaceForProject(
      projectId,
      workspaceId,
    );
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listExpiredDrafts",
        workspaceId: effectiveWs,
        entityId: projectId,
      },
      {
        mongo: () => this.mongo.listExpiredDrafts(projectId, now, limit),
        pg: () => this.pg.listExpiredDrafts(projectId, now, limit, effectiveWs),
        canonicalize: rows =>
          [...rows].sort((a, b) => a.id.localeCompare(b.id)),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async deleteDraftsByIds(
    projectId: string,
    ids: readonly string[],
    workspaceId?: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    const effectiveWs = await this.resolveCanaryWorkspaceForProject(
      projectId,
      workspaceId,
    );
    let deletedIds: string[] = [];
    await this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "deleteDraftsByIds",
        workspaceId: effectiveWs,
        entityId: ids[0],
        retryPayload: {
          table: "app_binding_drafts",
          projectId,
          deletedIds: [...ids],
          ...(effectiveWs ? { workspaceId: effectiveWs } : {}),
        },
      },
      {
        mongo: async () => {
          deletedIds = await this.mongo.deleteDraftsByIdsReturningIds(
            projectId,
            ids,
          );
        },
        pg: () => this.pg.deleteDraftsByIds(projectId, ids, effectiveWs),
      },
    );
    if (deletedIds.length > 0) {
      await this.maybeRecordTombstones(
        "app_binding_drafts",
        deletedIds,
        effectiveWs,
      );
    }
  }

  // ── 10. app_binding_jobs ─────────────────────────────────────────────────

  createBindingJob(input: CreateBindingJobInput): Promise<AppBindingJobRecord> {
    const id = input.id ?? newDualId().oid;
    const withId: CreateBindingJobInput = { ...input, id };
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "createBindingJob",
        workspaceId: input.workspaceId,
        entityId: id,
        retryPayload: {
          table: "app_binding_jobs",
          id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.createBindingJob(withId),
        pg: () => this.pg.createBindingJob(withId),
      },
    );
  }

  async findBindingJobById(
    jobId: string,
    projectId?: string,
    workspaceId?: string,
  ): Promise<AppBindingJobRecord | null> {
    if (!workspaceId) {
      const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
      if (pgOverrides) {
        const pgRow = await this.pg.findBindingJobById(jobId, projectId);
        if (pgRow && pgOverrides.has(pgRow.workspaceId)) {
          return pgRow;
        }
        const mongoRow = await this.mongo.findBindingJobById(jobId, projectId);
        if (mongoRow && pgOverrides.has(mongoRow.workspaceId)) {
          return null;
        }
        return mongoRow;
      }
    }
    return this.executeUserResolvedRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "findBindingJobById",
        workspaceId,
        entityId: jobId,
      },
      {
        mongo: () => this.mongo.findBindingJobById(jobId, projectId),
        pg: () => this.pg.findBindingJobById(jobId, projectId, workspaceId),
        collectRawUserIds: row => (row ? [row.actorId, row.userId] : []),
        canonicalize: canonicalizeBindingJobForShadow,
      },
    );
  }

  async casFailStaleBindingJob(
    jobId: string,
    staleBefore: Date,
    error: string,
    errorStatus: number,
    newExpiresAt: Date,
    workspaceId?: string,
  ): Promise<AppBindingJobRecord | null> {
    const effectiveWs = await this.resolveCanaryWorkspaceForBindingJob(
      jobId,
      workspaceId,
    );
    return this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "casFailStaleBindingJob",
        workspaceId: effectiveWs,
        entityId: jobId,
        retryPayload: {
          table: "app_binding_jobs",
          id: jobId,
          ...(effectiveWs ? { workspaceId: effectiveWs } : {}),
        },
      },
      {
        mongo: () =>
          this.mongo.casFailStaleBindingJob(
            jobId,
            staleBefore,
            error,
            errorStatus,
            newExpiresAt,
          ),
        pg: () =>
          this.pg.casFailStaleBindingJob(
            jobId,
            staleBefore,
            error,
            errorStatus,
            newExpiresAt,
            effectiveWs,
          ),
      },
    );
  }

  async listStaleRunningBindingJobs(
    staleBefore: Date,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      workspaceId: string;
      projectId: string;
      heartbeatAt: Date | null;
    }>
  > {
    const pgOverrides = await this.getCanaryPgOverridesIfGlobalMongoRead();
    if (pgOverrides) {
      const [mongoRows, pgRows] = await Promise.all([
        this.mongo.listStaleRunningBindingJobs(staleBefore, limit),
        this.pg.listStaleRunningBindingJobs(staleBefore, limit),
      ]);
      return [
        ...mongoRows.filter(r => !pgOverrides.has(r.workspaceId)),
        ...pgRows.filter(r => pgOverrides.has(r.workspaceId)),
      ].slice(0, limit);
    }
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listStaleRunningBindingJobs",
      },
      {
        mongo: () => this.mongo.listStaleRunningBindingJobs(staleBefore, limit),
        pg: () => this.pg.listStaleRunningBindingJobs(staleBefore, limit),
        canonicalize: rows =>
          [...rows].sort((a, b) => a.id.localeCompare(b.id)),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async heartbeatBindingJob(
    jobId: string,
    now: Date,
    newExpiresAt: Date,
    workspaceId?: string,
  ): Promise<void> {
    const effectiveWs = await this.resolveCanaryWorkspaceForBindingJob(
      jobId,
      workspaceId,
    );
    await this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "heartbeatBindingJob",
        workspaceId: effectiveWs,
        entityId: jobId,
        retryPayload: {
          table: "app_binding_jobs",
          id: jobId,
          ...(effectiveWs ? { workspaceId: effectiveWs } : {}),
        },
      },
      {
        mongo: () => this.mongo.heartbeatBindingJob(jobId, now, newExpiresAt),
        pg: () =>
          this.pg.heartbeatBindingJob(jobId, now, newExpiresAt, effectiveWs),
      },
    );
  }

  async updateBindingJobProgress(
    jobId: string,
    progress: AppBindingJobProgressRecord,
    workspaceId?: string,
  ): Promise<void> {
    const effectiveWs = await this.resolveCanaryWorkspaceForBindingJob(
      jobId,
      workspaceId,
    );
    await this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "updateBindingJobProgress",
        workspaceId: effectiveWs,
        entityId: jobId,
        retryPayload: {
          table: "app_binding_jobs",
          id: jobId,
          ...(effectiveWs ? { workspaceId: effectiveWs } : {}),
        },
      },
      {
        mongo: () => this.mongo.updateBindingJobProgress(jobId, progress),
        pg: () =>
          this.pg.updateBindingJobProgress(jobId, progress, effectiveWs),
      },
    );
  }

  async markBindingJob(
    jobId: string,
    update: MarkBindingJobUpdate,
    newExpiresAt: Date,
    heartbeatAt?: Date,
    workspaceId?: string,
  ): Promise<void> {
    const effectiveWs = await this.resolveCanaryWorkspaceForBindingJob(
      jobId,
      workspaceId,
    );
    await this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "markBindingJob",
        workspaceId: effectiveWs,
        entityId: jobId,
        retryPayload: {
          table: "app_binding_jobs",
          id: jobId,
          ...(effectiveWs ? { workspaceId: effectiveWs } : {}),
        },
      },
      {
        mongo: () =>
          this.mongo.markBindingJob(jobId, update, newExpiresAt, heartbeatAt),
        pg: () =>
          this.pg.markBindingJob(
            jobId,
            update,
            newExpiresAt,
            heartbeatAt,
            effectiveWs,
          ),
      },
    );
  }

  async listExpiredFinishedBindingJobs(
    projectId: string,
    now: Date,
    limit: number,
    workspaceId?: string,
  ): Promise<Array<{ id: string; result: AppBindingJobRecord["result"] }>> {
    const effectiveWs = await this.resolveCanaryWorkspaceForProject(
      projectId,
      workspaceId,
    );
    return this.router.executeRead(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "listExpiredFinishedBindingJobs",
        workspaceId: effectiveWs,
        entityId: projectId,
      },
      {
        mongo: () =>
          this.mongo.listExpiredFinishedBindingJobs(projectId, now, limit),
        pg: () =>
          this.pg.listExpiredFinishedBindingJobs(
            projectId,
            now,
            limit,
            effectiveWs,
          ),
        canonicalize: rows =>
          [...rows].sort((a, b) => a.id.localeCompare(b.id)),
        shadowOptions: APPS_METADATA_SHADOW_OPTIONS,
      },
    );
  }

  async deleteBindingJobsByIds(
    projectId: string,
    ids: readonly string[],
    workspaceId?: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    const effectiveWs = await this.resolveCanaryWorkspaceForProject(
      projectId,
      workspaceId,
    );
    let deletedIds: string[] = [];
    await this.router.executeWrite(
      {
        domain: APPS_METADATA_DOMAIN,
        operation: "deleteBindingJobsByIds",
        workspaceId: effectiveWs,
        entityId: ids[0],
        retryPayload: {
          table: "app_binding_jobs",
          projectId,
          deletedIds: [...ids],
          ...(effectiveWs ? { workspaceId: effectiveWs } : {}),
        },
      },
      {
        mongo: async () => {
          deletedIds = await this.mongo.deleteBindingJobsByIdsReturningIds(
            projectId,
            ids,
          );
        },
        pg: () => this.pg.deleteBindingJobsByIds(projectId, ids, effectiveWs),
      },
    );
    if (deletedIds.length > 0) {
      await this.maybeRecordTombstones(
        "app_binding_jobs",
        deletedIds,
        effectiveWs,
      );
    }
  }
}
