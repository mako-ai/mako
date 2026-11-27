/**
 * 5-stage workspace-scoped dual-run `ConsolesChartsRepository` powered by
 * `MigrationRouter` (`domain = "consoles_charts"`).
 *
 * Key guarantees:
 *   - Default mode is `mongo_only`; when `POSTGRES_URL` is unset, Postgres is never touched.
 *   - Zero extra Postgres queries on hot Mongo read paths in Stages 1–3.
 *   - Every create mints ONE bijective 24-hex ObjectId (`newDualId().oid`) written to
 *     both Mongo (`_id`) and Postgres (`objectIdToUuid(id)`).
 *   - Hard deletes during Stages 2 & 3 record tombstones in `migration_tombstones` so
 *     in-flight backfills cannot resurrect deleted rows.
 *   - Search (`vector`, `text`, `name`) shadow-compares top-K ID overlap instead of raw
 *     numerical scores (`ts_rank` vs `$meta: "textScore"`).
 *   - Cross-workspace cron (`findDueScheduledConsoles`) respects mixed per-workspace
 *     migration modes during incremental rollout.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import {
  getPgDb,
  hasPostgresConfig,
  type MakoPgDb,
} from "../../database/pg/client";
import {
  isUuidString,
  isUuidv7,
  newDualId,
  parseEntityId,
} from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import {
  migrationDomainState,
  migrationTombstones,
} from "../../database/pg/schema/control-plane";
import { loggers } from "../../logging";
import {
  isMigrationForceMongoOnly,
  migrationRouter,
  recordMigrationTombstone,
  type MigrationRouter,
  type RouterOperationContext,
} from "../../migration/router";
import type { ShadowCompareOptions } from "../../migration/types";
import {
  canonicalizeSearchResultsForCompare,
  collectUserIdsFromValue,
  normalizeUserIdsForShadowCompare,
  sortRecordsById,
  type UserUuidResolver,
} from "./mapper";
import { MongoConsolesChartsRepository } from "./mongo.repo";
import { PgConsolesChartsRepository } from "./pg.repo";
import type {
  ConsoleFolderRecord,
  ConsoleLastRunRecord,
  ConsoleSearchCandidate,
  ConsolesChartsRepository,
  CreateConsoleFolderInput,
  CreateConsoleInput,
  CreateEntityVersionInput,
  CreateFavouriteInput,
  CreateNotebookFolderInput,
  CreateNotebookIndexInput,
  CreateScheduledQueryRunInput,
  DueScheduledConsole,
  EntityVersionListItem,
  EntityVersionRecord,
  ExternalSource,
  FavouriteKind,
  FavouriteRecord,
  GuardedSaveConsoleInput,
  ListConsolesFilter,
  NotebookFolderRecord,
  NotebookIndexRecord,
  RecordScheduleOutcomeInput,
  ReorderFavouriteUpdate,
  ResourceShareEntryRecord,
  SavedConsoleRecord,
  ScheduledQueryRunRecord,
  UpdateConsoleFolderInput,
  UpdateConsolePatch,
  UpdateNotebookFolderInput,
  UpdateNotebookIndexInput,
  UpdateScheduledQueryRunInput,
} from "./types";

const logger = loggers.db("consoles-charts-repo");

export const CONSOLES_CHARTS_DOMAIN = "consoles_charts" as const;

export const CONSOLES_CHARTS_SHADOW_OPTIONS: ShadowCompareOptions = {
  treatNullAsUndefined: true,
};

export interface DualConsolesChartsRepositoryDeps {
  mongo?: MongoConsolesChartsRepository;
  pg?: PgConsolesChartsRepository;
  router?: MigrationRouter;
  getDb?: () => MakoPgDb;
  hasPg?: () => boolean;
  isForceMongoOnly?: () => boolean;
  resolveUserUuid?: UserUuidResolver;
}

function toPgEntityId(id: string): string {
  return parseEntityId(id)?.uuid ?? id.toLowerCase();
}

function isValidWorkspaceId(id: string): boolean {
  return parseEntityId(id) !== null;
}

export class DualConsolesChartsRepository implements ConsolesChartsRepository {
  readonly mongo: MongoConsolesChartsRepository;
  readonly pg: PgConsolesChartsRepository;
  private readonly router: MigrationRouter;
  private readonly getDb: () => MakoPgDb;
  private readonly hasPg: () => boolean;
  private readonly isForceMongoOnly: () => boolean;
  private readonly resolveUserUuidFn?: UserUuidResolver;
  private lastHasAnyPgReadWorkspace?: boolean;
  private lastIsGlobalPgOnly?: boolean;

  constructor(deps: DualConsolesChartsRepositoryDeps = {}) {
    this.mongo = deps.mongo ?? new MongoConsolesChartsRepository();
    this.pg =
      deps.pg ??
      new PgConsolesChartsRepository({
        getDb: deps.getDb,
        resolveUserUuid: deps.resolveUserUuid,
      });
    this.router = deps.router ?? migrationRouter;
    this.getDb = deps.getDb ?? getPgDb;
    this.hasPg = deps.hasPg ?? (deps.getDb ? () => true : hasPostgresConfig);
    this.isForceMongoOnly = deps.isForceMongoOnly ?? isMigrationForceMongoOnly;
    this.resolveUserUuidFn = deps.resolveUserUuid;
  }

  /**
   * Populate `userUuidMap` for off-critical-path shadow-compare canonicalization
   * (Stage 3 forward shadow and Stage 4 reverse shadow). NEVER called on unsampled
   * hot read paths.
   */
  private async populateShadowUserMap(
    value: unknown,
    userUuidMap: Map<string, string>,
  ): Promise<void> {
    const candidates: string[] = [];
    for (const id of collectUserIdsFromValue(value)) {
      if (!isUuidv7(id) && !userUuidMap.has(id)) {
        candidates.push(id);
      }
    }
    if (candidates.length === 0) return;

    if (this.resolveUserUuidFn) {
      for (const id of candidates) {
        const resolved = await Promise.resolve(
          this.resolveUserUuidFn(id),
        ).catch(() => null);
        if (resolved) {
          userUuidMap.set(id, resolved.toLowerCase());
        }
      }
      return;
    }

    try {
      const uuidCandidates: string[] = [];
      for (const id of candidates) {
        if (isUuidString(id)) {
          uuidCandidates.push(id.toLowerCase());
        }
      }
      const conds = [inArray(users.legacyId, candidates)];
      if (uuidCandidates.length > 0) {
        conds.push(inArray(users.id, uuidCandidates));
      }
      const filter = conds.length === 1 ? conds[0] : or(...conds);
      const rows = await this.getDb()
        .select({ id: users.id, legacyId: users.legacyId })
        .from(users)
        .where(filter);
      for (const row of rows) {
        const canonical = row.id.toLowerCase();
        userUuidMap.set(canonical, canonical);
        if (row.legacyId) {
          userUuidMap.set(row.legacyId, canonical);
          userUuidMap.set(row.legacyId.toLowerCase(), canonical);
        }
      }
    } catch {
      // Best-effort shadow normalization; never disrupt primary reads.
    }
  }

  /**
   * Batch-resolve PG UUIDv7 `users.id` values back to Mongo `_id` (`legacy_id ?? id`)
   * strictly for Stage 4 (`dual_write_pg_read`) secondary Mongo writes and reverse-shadow
   * reads. Never called in Stages 1–3 or Stage 5 (zero extra PG queries on Mongo hot paths).
   */
  private async resolveMongoUserIdMap(
    rawIds: readonly (string | null | undefined)[],
  ): Promise<Map<string, string>> {
    const uuids = [
      ...new Set(
        rawIds
          .filter((v): v is string => typeof v === "string" && isUuidString(v))
          .map(v => v.toLowerCase()),
      ),
    ];
    const map = new Map<string, string>();
    if (uuids.length === 0) return map;
    const rows = await this.getDb()
      .select({ id: users.id, legacyId: users.legacyId })
      .from(users)
      .where(inArray(users.id, uuids));
    for (const row of rows) {
      map.set(row.id.toLowerCase(), row.legacyId ?? row.id);
    }
    return map;
  }

  private mapUserIdForMongo<T extends string | null | undefined>(
    raw: T,
    legacyMap: ReadonlyMap<string, string>,
  ): T {
    if (typeof raw !== "string") return raw;
    return (legacyMap.get(raw.toLowerCase()) ?? raw) as T;
  }

  private async resolveSingleMongoUserId<T extends string | null | undefined>(
    raw: T,
    pgPrimary: boolean,
  ): Promise<T> {
    if (!pgPrimary || typeof raw !== "string" || !isUuidString(raw)) {
      return raw;
    }
    const map = await this.resolveMongoUserIdMap([raw]);
    return this.mapUserIdForMongo(raw, map);
  }

  private mapShareEntriesForMongo(
    entries: ResourceShareEntryRecord[] | undefined,
    legacyMap: ReadonlyMap<string, string>,
  ): ResourceShareEntryRecord[] | undefined {
    if (!entries) return entries;
    return entries.map(s => ({
      ...s,
      userId: this.mapUserIdForMongo(s.userId, legacyMap),
      ...(s.addedBy !== undefined
        ? { addedBy: this.mapUserIdForMongo(s.addedBy, legacyMap) }
        : {}),
    }));
  }

  private mapLastRunForMongo(
    lastRun: ConsoleLastRunRecord | null | undefined,
    legacyMap: ReadonlyMap<string, string>,
  ): ConsoleLastRunRecord | null | undefined {
    if (!lastRun) return lastRun;
    return {
      ...lastRun,
      runBy: this.mapUserIdForMongo(lastRun.runBy, legacyMap),
    };
  }

  private async mapConsoleCreateForMongo(
    input: CreateConsoleInput,
    pgPrimary: boolean,
  ): Promise<CreateConsoleInput> {
    if (!pgPrimary) return input;
    const legacyMap = await this.resolveMongoUserIdMap([
      input.createdBy,
      input.owner_id,
      input.lastRun?.runBy,
      ...(input.sharedWith?.flatMap(s => [s.userId, s.addedBy]) ?? []),
    ]);
    if (legacyMap.size === 0) return input;
    return {
      ...input,
      createdBy: this.mapUserIdForMongo(input.createdBy, legacyMap),
      owner_id: this.mapUserIdForMongo(input.owner_id, legacyMap),
      sharedWith: this.mapShareEntriesForMongo(input.sharedWith, legacyMap),
      lastRun: this.mapLastRunForMongo(input.lastRun, legacyMap),
    };
  }

  private async mapConsolePatchForMongo(
    patch: UpdateConsolePatch,
    pgPrimary: boolean,
  ): Promise<UpdateConsolePatch> {
    if (!pgPrimary) return patch;
    const legacyMap = await this.resolveMongoUserIdMap([
      patch.owner_id,
      patch.lastRun?.runBy,
      ...(patch.sharedWith?.flatMap(s => [s.userId, s.addedBy]) ?? []),
    ]);
    if (legacyMap.size === 0) return patch;
    return {
      ...patch,
      ...(patch.owner_id !== undefined
        ? { owner_id: this.mapUserIdForMongo(patch.owner_id, legacyMap) }
        : {}),
      ...(patch.sharedWith !== undefined
        ? {
            sharedWith: this.mapShareEntriesForMongo(
              patch.sharedWith,
              legacyMap,
            ),
          }
        : {}),
      ...(patch.lastRun !== undefined
        ? { lastRun: this.mapLastRunForMongo(patch.lastRun, legacyMap) }
        : {}),
    };
  }

  /**
   * Wrapper around `router.executeRead` that normalizes legacy user IDs (Lucia 15-char,
   * UUIDv4) <-> PG UUIDv7 ONLY when a background shadow comparison actually runs, and
   * passes `pgPrimary = true` to `handlers.mongo` strictly on Stage 4 reverse-shadow reads.
   */
  private executeShadowRead<T>(
    ctx: RouterOperationContext,
    handlers: {
      mongo: (pgPrimary: boolean) => Promise<T>;
      pg: () => Promise<T>;
      canonicalize?: (value: T) => unknown;
      shadowOptions?: ShadowCompareOptions;
    },
  ): Promise<T> {
    const userUuidMap = new Map<string, string>();
    let mongoResult: T | undefined;
    let mongoRan = false;
    let pgRan = false;
    const baseCanonicalize = handlers.canonicalize;

    return this.router.executeRead(ctx, {
      mongo: async () => {
        const res = await handlers.mongo(pgRan);
        mongoResult = res;
        mongoRan = true;
        if (pgRan) {
          await this.populateShadowUserMap(res, userUuidMap);
        }
        return res;
      },
      pg: async () => {
        pgRan = true;
        const res = await handlers.pg();
        if (mongoRan) {
          await this.populateShadowUserMap(mongoResult, userUuidMap);
        }
        return res;
      },
      canonicalize: value => {
        const base = baseCanonicalize ? baseCanonicalize(value) : value;
        return normalizeUserIdsForShadowCompare(base, userUuidMap);
      },
      shadowOptions: handlers.shadowOptions ?? CONSOLES_CHARTS_SHADOW_OPTIONS,
    });
  }

  /**
   * Wrapper around `router.executeWrite` that informs `handlers.mongo` whether PG
   * already ran as primary (`pgPrimary === true`, i.e., Stage 4 `dual_write_pg_read`)
   * so Mongo secondary writes reverse-map PG UUIDv7 user IDs back to `legacy_id`
   * with zero extra PG queries in Stages 1–3.
   */
  private executeTrackedWrite<T>(
    ctx: RouterOperationContext,
    handlers: {
      mongo: (pgPrimary: boolean) => Promise<T>;
      pg: () => Promise<T>;
    },
  ): Promise<T> {
    let pgRan = false;
    return this.router.executeWrite(ctx, {
      mongo: () => handlers.mongo(pgRan),
      pg: async () => {
        pgRan = true;
        return handlers.pg();
      },
    });
  }

  /**
   * Wrapper around `router.executeWrite` that gates the secondary store write on
   * whether the primary store actually mutated a row. Prevents throttled no-ops,
   * optimistic concurrency conflicts, CAS misses, and unauthorized/wrong-workspace
   * deletes from touching the secondary DB, emitting spurious sync-retry events, or
   * diverging the secondary store.
   *
   * Conversely, when the primary store DID mutate a row (`primaryMutated === true`)
   * and the secondary store matched 0 rows (`!isMutated(secondaryResult)`) on a
   * non-delete mutation, throws so `MigrationRouter` records the drift and dispatches
   * a full-row sync-retry instead of silently leaving guarded/relative writes diverged.
   * Passes `pgPrimary === true` to `handlers.mongo` strictly in Stage 4 (`dual_write_pg_read`).
   */
  private executeGatedWrite<T>(
    ctx: RouterOperationContext,
    handlers: {
      mongo: (pgPrimary: boolean, primaryResult?: NoInfer<T>) => Promise<T>;
      pg: (primaryResult?: NoInfer<T>) => Promise<T>;
    },
    isMutated: (result: T) => boolean,
    noopResult: T,
    opts?: { allowSecondaryNoop?: boolean },
  ): Promise<T> {
    let primaryRan = false;
    let primaryMutated = false;
    let primaryResult: T | undefined;
    let pgRan = false;
    const allowSecondaryNoop = opts?.allowSecondaryNoop ?? false;
    return this.router.executeWrite(ctx, {
      mongo: async () => {
        if (primaryRan) {
          if (!primaryMutated) return noopResult;
          const res = await handlers.mongo(pgRan, primaryResult);
          if (!allowSecondaryNoop && !isMutated(res)) {
            throw new Error(
              `Secondary mongo write matched 0 rows for ${ctx.domain}.${ctx.operation} (primary mutated)`,
            );
          }
          return res;
        }
        const res = await handlers.mongo(false);
        primaryRan = true;
        primaryResult = res;
        primaryMutated = isMutated(res);
        return res;
      },
      pg: async () => {
        if (primaryRan) {
          if (!primaryMutated) return noopResult;
          const res = await handlers.pg(primaryResult);
          if (!allowSecondaryNoop && !isMutated(res)) {
            throw new Error(
              `Secondary pg write matched 0 rows for ${ctx.domain}.${ctx.operation} (primary mutated)`,
            );
          }
          return res;
        }
        pgRan = true;
        const res = await handlers.pg();
        primaryRan = true;
        primaryResult = res;
        primaryMutated = isMutated(res);
        return res;
      },
    });
  }

  private async isMongoPrimaryDualWrite(
    workspaceId?: string,
  ): Promise<boolean> {
    const mode = (
      await this.router.getState(CONSOLES_CHARTS_DOMAIN, workspaceId)
    ).mode;
    return (
      mode === "dual_write_mongo_read" || mode === "dual_write_shadow_compare"
    );
  }

  private async isPgReadMode(workspaceId?: string): Promise<boolean> {
    const mode = (
      await this.router.getState(CONSOLES_CHARTS_DOMAIN, workspaceId)
    ).mode;
    return mode === "dual_write_pg_read" || mode === "pg_only";
  }

  private async recordTombstonesIfDualWrite(
    workspaceId: string,
    tableName: string,
    entityIds: Iterable<string>,
  ): Promise<void> {
    if (!(await this.isMongoPrimaryDualWrite(workspaceId))) return;
    try {
      const db = this.getDb();
      for (const id of entityIds) {
        if (id) {
          await recordMigrationTombstone(tableName, toPgEntityId(id), db);
        }
      }
    } catch (error) {
      // Never fail a successful Stage 2/3 Mongo-primary delete if PG is transiently unreachable.
      logger.warn("Failed to record delete tombstone in Postgres", {
        workspaceId,
        tableName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Clear any prior tombstone for an entity ID when it is created or upserted
   * (e.g. deterministic SHA-1 IDs `sha1("consoles:<ws>:<path>")`, folders,
   * versions, and notebooks re-created after a workspace repo disconnect/reconnect).
   * Strictly a no-op in `mongo_only` mode (zero PG calls).
   */
  private async clearTombstoneIfActive(
    workspaceId: string,
    tableName: string,
    entityId: string,
  ): Promise<void> {
    if (!entityId || this.isForceMongoOnly() || !this.hasPg()) return;
    const mode = (
      await this.router.getState(CONSOLES_CHARTS_DOMAIN, workspaceId)
    ).mode;
    if (mode === "mongo_only") return;
    try {
      await this.getDb()
        .delete(migrationTombstones)
        .where(
          and(
            eq(migrationTombstones.tableName, tableName),
            eq(migrationTombstones.entityId, toPgEntityId(entityId)),
          ),
        );
    } catch (error) {
      logger.warn("Failed to clear migration tombstone in Postgres", {
        workspaceId,
        tableName,
        entityId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async hasAnyPgReadWorkspace(): Promise<boolean> {
    if (this.isForceMongoOnly() || !this.hasPg()) return false;
    try {
      const rows = await this.getDb()
        .select({ mode: migrationDomainState.mode })
        .from(migrationDomainState)
        .where(
          and(
            eq(migrationDomainState.domain, CONSOLES_CHARTS_DOMAIN),
            inArray(migrationDomainState.mode, [
              "dual_write_pg_read",
              "pg_only",
            ]),
          ),
        )
        .limit(1);
      const result = rows.length > 0;
      this.lastHasAnyPgReadWorkspace = result;
      return result;
    } catch (error) {
      if (this.lastHasAnyPgReadWorkspace !== undefined) {
        logger.error(
          "Failed to query migration_domain_state for hasAnyPgReadWorkspace; serving stale cached flag",
          {
            staleValue: this.lastHasAnyPgReadWorkspace,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return this.lastHasAnyPgReadWorkspace;
      }
      throw error;
    }
  }

  /**
   * True when the global domain mode is `pg_only` and no workspace override still reads Mongo.
   * Ensures cross-workspace scans (`findDueScheduledConsoles`, `listConsolesNeedingDescription`,
   * `findConsoleByIdGlobal`, `findScheduledQueryRunById`) never touch Mongo in Stage 5.
   */
  private async isGlobalPgOnly(): Promise<boolean> {
    if (this.isForceMongoOnly() || !this.hasPg()) return false;
    const globalState = await this.router.getState(CONSOLES_CHARTS_DOMAIN);
    if (globalState.mode !== "pg_only") {
      this.lastIsGlobalPgOnly = false;
      return false;
    }
    try {
      const mongoOverrides = await this.getDb()
        .select({ mode: migrationDomainState.mode })
        .from(migrationDomainState)
        .where(
          and(
            eq(migrationDomainState.domain, CONSOLES_CHARTS_DOMAIN),
            inArray(migrationDomainState.mode, [
              "mongo_only",
              "dual_write_mongo_read",
              "dual_write_shadow_compare",
            ]),
          ),
        )
        .limit(1);
      const result = mongoOverrides.length === 0;
      this.lastIsGlobalPgOnly = result;
      return result;
    } catch (error) {
      if (this.lastIsGlobalPgOnly !== undefined) {
        logger.error(
          "Failed to query migration_domain_state for isGlobalPgOnly; serving stale cached flag",
          {
            staleValue: this.lastIsGlobalPgOnly,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return this.lastIsGlobalPgOnly;
      }
      throw error;
    }
  }

  // ── 1. Console folders ────────────────────────────────────────────────

  listConsoleFolders(
    workspaceId: string,
    opts?: { sortByName?: boolean },
  ): Promise<ConsoleFolderRecord[]> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "listConsoleFolders",
      },
      {
        mongo: () => this.mongo.listConsoleFolders(workspaceId, opts),
        pg: () => this.pg.listConsoleFolders(workspaceId, opts),
        canonicalize: rows =>
          opts?.sortByName
            ? [...rows].sort((a, b) =>
                a.name < b.name
                  ? -1
                  : a.name > b.name
                    ? 1
                    : a.id.localeCompare(b.id),
              )
            : sortRecordsById(rows),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  findConsoleFolderById(
    workspaceId: string,
    folderId: string,
  ): Promise<ConsoleFolderRecord | null> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "findConsoleFolderById",
        entityId: folderId,
      },
      {
        mongo: () => this.mongo.findConsoleFolderById(workspaceId, folderId),
        pg: () => this.pg.findConsoleFolderById(workspaceId, folderId),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  findConsoleFoldersByIds(
    workspaceId: string,
    folderIds: readonly string[],
  ): Promise<ConsoleFolderRecord[]> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "findConsoleFoldersByIds",
      },
      {
        mongo: () => this.mongo.findConsoleFoldersByIds(workspaceId, folderIds),
        pg: () => this.pg.findConsoleFoldersByIds(workspaceId, folderIds),
        canonicalize: sortRecordsById,
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  findConsoleFolderByNameAndParent(
    workspaceId: string,
    name: string,
    parentId: string | null,
  ): Promise<ConsoleFolderRecord | null> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "findConsoleFolderByNameAndParent",
      },
      {
        mongo: () =>
          this.mongo.findConsoleFolderByNameAndParent(
            workspaceId,
            name,
            parentId,
          ),
        pg: () =>
          this.pg.findConsoleFolderByNameAndParent(workspaceId, name, parentId),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  listChildConsoleFolders(
    workspaceId: string,
    parentId: string | null,
  ): Promise<ConsoleFolderRecord[]> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "listChildConsoleFolders",
      },
      {
        mongo: () => this.mongo.listChildConsoleFolders(workspaceId, parentId),
        pg: () => this.pg.listChildConsoleFolders(workspaceId, parentId),
        canonicalize: sortRecordsById,
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  async createConsoleFolder(
    input: CreateConsoleFolderInput,
  ): Promise<ConsoleFolderRecord> {
    const id = input.id ?? newDualId().oid;
    const createdAt = input.createdAt ?? new Date();
    const fullInput: CreateConsoleFolderInput = { ...input, id, createdAt };
    const created = await this.executeTrackedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "createConsoleFolder",
        entityId: id,
        retryPayload: {
          table: "console_folders",
          action: "upsert",
          id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: async pgPrimary => {
          const ownerId = await this.resolveSingleMongoUserId(
            fullInput.ownerId,
            pgPrimary,
          );
          return this.mongo.createConsoleFolder({ ...fullInput, ownerId });
        },
        pg: () => this.pg.createConsoleFolder(fullInput),
      },
    );
    await this.clearTombstoneIfActive(
      input.workspaceId,
      "console_folders",
      created.id,
    );
    return created;
  }

  updateConsoleFolder(
    workspaceId: string,
    folderId: string,
    patch: UpdateConsoleFolderInput,
  ): Promise<ConsoleFolderRecord | null> {
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "updateConsoleFolder",
        entityId: folderId,
        retryPayload: {
          table: "console_folders",
          action: "upsert",
          id: folderId,
          workspaceId,
        },
      },
      {
        mongo: async pgPrimary => {
          const mappedPatch =
            pgPrimary && patch.ownerId !== undefined
              ? {
                  ...patch,
                  ownerId: await this.resolveSingleMongoUserId(
                    patch.ownerId,
                    pgPrimary,
                  ),
                }
              : patch;
          return this.mongo.updateConsoleFolder(
            workspaceId,
            folderId,
            mappedPatch,
          );
        },
        pg: () => this.pg.updateConsoleFolder(workspaceId, folderId, patch),
      },
      res => res !== null,
      null,
    );
  }

  async deleteConsoleFolder(
    workspaceId: string,
    folderId: string,
  ): Promise<boolean> {
    let deletedIds: string[] = [];
    const retryPayload: Record<string, unknown> = {
      table: "console_folders",
      action: "delete",
      id: folderId,
      workspaceId,
    };
    const deleted = await this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "deleteConsoleFolder",
        entityId: folderId,
        retryPayload,
      },
      {
        mongo: async () => {
          const ids = await this.mongo.deleteConsoleFolderReturningIds(
            workspaceId,
            folderId,
          );
          if (ids.length > 0 && deletedIds.length === 0) {
            deletedIds = ids;
            retryPayload.deletedIds = ids;
          }
          return ids.length > 0;
        },
        pg: () => this.pg.deleteConsoleFolder(workspaceId, folderId),
      },
      res => res,
      false,
      { allowSecondaryNoop: true },
    );
    if (deleted && deletedIds.length > 0) {
      await this.recordTombstonesIfDualWrite(
        workspaceId,
        "console_folders",
        deletedIds,
      );
    }
    return deleted;
  }

  wouldCreateConsoleFolderCycle(
    workspaceId: string,
    folderId: string,
    targetParentId: string | null,
  ): Promise<boolean> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "wouldCreateConsoleFolderCycle",
        entityId: folderId,
      },
      {
        mongo: () =>
          this.mongo.wouldCreateConsoleFolderCycle(
            workspaceId,
            folderId,
            targetParentId,
          ),
        pg: () =>
          this.pg.wouldCreateConsoleFolderCycle(
            workspaceId,
            folderId,
            targetParentId,
          ),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  // ── 2. Saved consoles ─────────────────────────────────────────────────

  findConsoleById(
    workspaceId: string,
    consoleId: string,
    opts?: { includeEmbedding?: boolean; excludeDeleted?: boolean },
  ): Promise<SavedConsoleRecord | null> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "findConsoleById",
        entityId: consoleId,
      },
      {
        mongo: () => this.mongo.findConsoleById(workspaceId, consoleId, opts),
        pg: () => this.pg.findConsoleById(workspaceId, consoleId, opts),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  async findConsoleByIdGlobal(
    consoleId: string,
    opts?: { includeEmbedding?: boolean },
  ): Promise<SavedConsoleRecord | null> {
    if (await this.isGlobalPgOnly()) {
      return this.pg.findConsoleByIdGlobal(consoleId, opts);
    }
    if (await this.hasAnyPgReadWorkspace()) {
      const pgRow = await this.pg.findConsoleByIdGlobal(consoleId, opts);
      if (pgRow && (await this.isPgReadMode(pgRow.workspaceId))) {
        return pgRow;
      }
      const mongoRow = await this.mongo.findConsoleByIdGlobal(consoleId, opts);
      if (mongoRow && !(await this.isPgReadMode(mongoRow.workspaceId))) {
        return mongoRow;
      }
      return null;
    }
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        operation: "findConsoleByIdGlobal",
        entityId: consoleId,
      },
      {
        mongo: () => this.mongo.findConsoleByIdGlobal(consoleId, opts),
        pg: () => this.pg.findConsoleByIdGlobal(consoleId, opts),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  findConsolesByIds(
    workspaceId: string,
    consoleIds: readonly string[],
  ): Promise<SavedConsoleRecord[]> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "findConsolesByIds",
      },
      {
        mongo: () => this.mongo.findConsolesByIds(workspaceId, consoleIds),
        pg: () => this.pg.findConsolesByIds(workspaceId, consoleIds),
        canonicalize: sortRecordsById,
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  findConsoleByPath(
    workspaceId: string,
    path: string,
    opts?: { isSavedOnly?: boolean },
  ): Promise<SavedConsoleRecord | null> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "findConsoleByPath",
      },
      {
        mongo: () => this.mongo.findConsoleByPath(workspaceId, path, opts),
        pg: () => this.pg.findConsoleByPath(workspaceId, path, opts),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  findConsoleByNameAndFolder(
    workspaceId: string,
    name: string,
    folderId: string | null,
    opts?: { isSavedOnly?: boolean },
  ): Promise<SavedConsoleRecord | null> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "findConsoleByNameAndFolder",
      },
      {
        mongo: () =>
          this.mongo.findConsoleByNameAndFolder(
            workspaceId,
            name,
            folderId,
            opts,
          ),
        pg: () =>
          this.pg.findConsoleByNameAndFolder(workspaceId, name, folderId, opts),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  listConsolesByWorkspace(
    workspaceId: string,
    filter?: ListConsolesFilter,
  ): Promise<SavedConsoleRecord[]> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "listConsolesByWorkspace",
      },
      {
        mongo: () => this.mongo.listConsolesByWorkspace(workspaceId, filter),
        pg: () => this.pg.listConsolesByWorkspace(workspaceId, filter),
        canonicalize: rows => (filter?.sortBy ? rows : sortRecordsById(rows)),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  async listConsolesNeedingDescription(opts?: {
    workspaceId?: string;
    currentEmbeddingModel?: string | null;
  }): Promise<Array<{ id: string; workspaceId: string }>> {
    if (opts?.workspaceId !== undefined) {
      if (!isValidWorkspaceId(opts.workspaceId)) return [];
      return this.executeShadowRead(
        {
          domain: CONSOLES_CHARTS_DOMAIN,
          workspaceId: opts.workspaceId,
          operation: "listConsolesNeedingDescription",
        },
        {
          mongo: () => this.mongo.listConsolesNeedingDescription(opts),
          pg: () => this.pg.listConsolesNeedingDescription(opts),
          canonicalize: rows =>
            [...rows].sort((a, b) => a.id.localeCompare(b.id)),
          shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
        },
      );
    }

    if (await this.isGlobalPgOnly()) {
      return this.pg.listConsolesNeedingDescription(opts);
    }

    const mongoRows = await this.mongo.listConsolesNeedingDescription(opts);
    if (!(await this.hasAnyPgReadWorkspace())) return mongoRows;
    const pgRows = await this.pg.listConsolesNeedingDescription(opts);
    const merged = new Map<string, { id: string; workspaceId: string }>();
    for (const r of mongoRows) {
      if (!(await this.isPgReadMode(r.workspaceId))) merged.set(r.id, r);
    }
    for (const r of pgRows) {
      if (await this.isPgReadMode(r.workspaceId)) merged.set(r.id, r);
    }
    return [...merged.values()];
  }

  async createConsole(input: CreateConsoleInput): Promise<SavedConsoleRecord> {
    const id = input.id ?? newDualId().oid;
    const now = new Date();
    const fullInput: CreateConsoleInput = {
      ...input,
      id,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    let primaryRecord: SavedConsoleRecord | null = null;
    const created = await this.executeTrackedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "createConsole",
        entityId: id,
        retryPayload: {
          table: "saved_consoles",
          action: "upsert",
          id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: async pgPrimary => {
          const mappedInput = await this.mapConsoleCreateForMongo(
            fullInput,
            pgPrimary,
          );
          try {
            const res = await this.mongo.createConsole(mappedInput);
            if (!primaryRecord) primaryRecord = res;
            return res;
          } catch (error) {
            if (
              pgPrimary &&
              primaryRecord &&
              (error as { code?: number }).code === 11000
            ) {
              const legacyMap = await this.resolveMongoUserIdMap([
                primaryRecord.createdBy,
                primaryRecord.owner_id,
                primaryRecord.lastRun?.runBy,
                ...primaryRecord.sharedWith.flatMap(s => [s.userId, s.addedBy]),
              ]);
              const mongoRec: SavedConsoleRecord = {
                ...primaryRecord,
                createdBy: this.mapUserIdForMongo(
                  primaryRecord.createdBy,
                  legacyMap,
                ),
                owner_id: this.mapUserIdForMongo(
                  primaryRecord.owner_id,
                  legacyMap,
                ),
                sharedWith:
                  this.mapShareEntriesForMongo(
                    primaryRecord.sharedWith,
                    legacyMap,
                  ) ?? primaryRecord.sharedWith,
                lastRun:
                  this.mapLastRunForMongo(primaryRecord.lastRun, legacyMap) ??
                  undefined,
              };
              await this.mongo.upsertConsole(mongoRec);
              return primaryRecord;
            }
            throw error;
          }
        },
        pg: async () => {
          try {
            const res = await this.pg.createConsole(fullInput);
            if (!primaryRecord) primaryRecord = res;
            return res;
          } catch (error) {
            const code =
              (error as { code?: unknown; cause?: { code?: unknown } }).code ??
              (error as { cause?: { code?: unknown } }).cause?.code;
            if (primaryRecord && code === "23505") {
              await this.pg.upsertConsole(primaryRecord, {
                ignoreUpdatedAtGuard: true,
              });
              return primaryRecord;
            }
            throw error;
          }
        },
      },
    );
    await this.clearTombstoneIfActive(
      input.workspaceId,
      "saved_consoles",
      created.id,
    );
    return created;
  }

  updateConsole(
    workspaceId: string,
    consoleId: string,
    patch: UpdateConsolePatch,
  ): Promise<SavedConsoleRecord | null> {
    const stampedPatch: UpdateConsolePatch = {
      ...patch,
      updatedAt: patch.updatedAt ?? new Date(),
    };
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "updateConsole",
        entityId: consoleId,
        retryPayload: {
          table: "saved_consoles",
          action: "upsert",
          id: consoleId,
          workspaceId,
        },
      },
      {
        mongo: async pgPrimary =>
          this.mongo.updateConsole(
            workspaceId,
            consoleId,
            await this.mapConsolePatchForMongo(stampedPatch, pgPrimary),
          ),
        pg: () => this.pg.updateConsole(workspaceId, consoleId, stampedPatch),
      },
      res => res !== null,
      null,
    );
  }

  updateConsolesInFolder(
    workspaceId: string,
    folderId: string,
    patch: Pick<UpdateConsolePatch, "access" | "isPrivate">,
    updatedAt: Date = new Date(),
  ): Promise<number> {
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "updateConsolesInFolder",
        entityId: folderId,
        retryPayload: {
          table: "saved_consoles",
          action: "update_folder_access",
          folderId,
          workspaceId,
        },
      },
      {
        mongo: () =>
          this.mongo.updateConsolesInFolder(
            workspaceId,
            folderId,
            patch,
            updatedAt,
          ),
        pg: () =>
          this.pg.updateConsolesInFolder(
            workspaceId,
            folderId,
            patch,
            updatedAt,
          ),
      },
      count => count > 0,
      0,
    );
  }

  async guardedSaveConsole(
    input: GuardedSaveConsoleInput,
  ): Promise<SavedConsoleRecord | null> {
    const now = input.set.updatedAt ?? new Date();
    const stamped: GuardedSaveConsoleInput = {
      ...input,
      set: {
        ...input.set,
        updatedAt: now,
      },
      ...(input.upsert
        ? {
            setOnInsert: {
              ...input.setOnInsert,
              createdAt: input.setOnInsert?.createdAt ?? now,
            },
          }
        : {}),
    };
    const saved = await this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "guardedSaveConsole",
        entityId: input.consoleId,
        retryPayload: {
          table: "saved_consoles",
          action: "upsert",
          id: input.consoleId,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: async pgPrimary => {
          if (!pgPrimary) return this.mongo.guardedSaveConsole(stamped);
          const soi = stamped.setOnInsert;
          const legacyMap = await this.resolveMongoUserIdMap([
            stamped.set.owner_id,
            stamped.set.lastRun?.runBy,
            ...(stamped.set.sharedWith?.flatMap(s => [s.userId, s.addedBy]) ??
              []),
            soi?.createdBy,
            soi?.owner_id,
            soi?.lastRun?.runBy,
            ...(soi?.sharedWith?.flatMap(s => [s.userId, s.addedBy]) ?? []),
          ]);
          if (legacyMap.size === 0) {
            return this.mongo.guardedSaveConsole(stamped);
          }
          const mappedSet: UpdateConsolePatch = {
            ...stamped.set,
            ...(stamped.set.owner_id !== undefined
              ? {
                  owner_id: this.mapUserIdForMongo(
                    stamped.set.owner_id,
                    legacyMap,
                  ),
                }
              : {}),
            ...(stamped.set.sharedWith !== undefined
              ? {
                  sharedWith: this.mapShareEntriesForMongo(
                    stamped.set.sharedWith,
                    legacyMap,
                  ),
                }
              : {}),
            ...(stamped.set.lastRun !== undefined
              ? {
                  lastRun: this.mapLastRunForMongo(
                    stamped.set.lastRun,
                    legacyMap,
                  ),
                }
              : {}),
          };
          const mappedSetOnInsert = soi
            ? {
                ...soi,
                ...(soi.createdBy !== undefined
                  ? {
                      createdBy: this.mapUserIdForMongo(
                        soi.createdBy,
                        legacyMap,
                      ),
                    }
                  : {}),
                ...(soi.owner_id !== undefined
                  ? {
                      owner_id: this.mapUserIdForMongo(soi.owner_id, legacyMap),
                    }
                  : {}),
                ...(soi.sharedWith !== undefined
                  ? {
                      sharedWith: this.mapShareEntriesForMongo(
                        soi.sharedWith,
                        legacyMap,
                      ),
                    }
                  : {}),
                ...(soi.lastRun !== undefined
                  ? {
                      lastRun: this.mapLastRunForMongo(soi.lastRun, legacyMap),
                    }
                  : {}),
              }
            : undefined;
          return this.mongo.guardedSaveConsole({
            ...stamped,
            set: mappedSet,
            ...(mappedSetOnInsert !== undefined
              ? { setOnInsert: mappedSetOnInsert }
              : {}),
          });
        },
        pg: () => this.pg.guardedSaveConsole(stamped),
      },
      res => res !== null,
      null,
    );
    if (saved) {
      await this.clearTombstoneIfActive(
        input.workspaceId,
        "saved_consoles",
        saved.id,
      );
    }
    return saved;
  }

  bumpConsoleDraftRevision(
    workspaceId: string,
    consoleId: string,
    updatedAt: Date = new Date(),
  ): Promise<SavedConsoleRecord | null> {
    return this.executeGatedWrite<SavedConsoleRecord | null>(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "bumpConsoleDraftRevision",
        entityId: consoleId,
        retryPayload: {
          table: "saved_consoles",
          action: "upsert",
          id: consoleId,
          workspaceId,
        },
      },
      {
        mongo: (_pgPrimary, primaryResult) =>
          primaryResult != null
            ? this.mongo.updateConsole(workspaceId, consoleId, {
                draftRevision: primaryResult.draftRevision,
                updatedAt,
              })
            : this.mongo.bumpConsoleDraftRevision(
                workspaceId,
                consoleId,
                updatedAt,
              ),
        pg: primaryResult =>
          primaryResult != null
            ? this.pg.updateConsole(workspaceId, consoleId, {
                draftRevision: primaryResult.draftRevision,
                updatedAt,
              })
            : this.pg.bumpConsoleDraftRevision(
                workspaceId,
                consoleId,
                updatedAt,
              ),
      },
      res => res !== null,
      null,
    );
  }

  recordConsoleExecution(
    workspaceId: string,
    consoleId: string,
    input: {
      lastExecutedAt: Date;
      lastRun?: ConsoleLastRunRecord;
      bumpDraftRevision?: boolean;
      updatedAt?: Date;
    },
  ): Promise<boolean> {
    const stamped = {
      ...input,
      updatedAt: input.updatedAt ?? input.lastExecutedAt,
    };
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "recordConsoleExecution",
        entityId: consoleId,
        retryPayload: {
          table: "saved_consoles",
          action: "upsert",
          id: consoleId,
          workspaceId,
        },
      },
      {
        mongo: async pgPrimary => {
          if (!pgPrimary || !stamped.lastRun) {
            return this.mongo.recordConsoleExecution(
              workspaceId,
              consoleId,
              stamped,
            );
          }
          const legacyMap = await this.resolveMongoUserIdMap([
            stamped.lastRun.runBy,
          ]);
          return this.mongo.recordConsoleExecution(workspaceId, consoleId, {
            ...stamped,
            lastRun:
              this.mapLastRunForMongo(stamped.lastRun, legacyMap) ?? undefined,
          });
        },
        pg: () =>
          this.pg.recordConsoleExecution(workspaceId, consoleId, stamped),
      },
      res => res,
      false,
    );
  }

  recordConsoleExternalUse(
    workspaceId: string,
    consoleId: string,
    source: ExternalSource,
    mode: "execute" | "access",
    now: Date = new Date(),
  ): Promise<boolean> {
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "recordConsoleExternalUse",
        entityId: consoleId,
        retryPayload: {
          table: "saved_consoles",
          action: "upsert",
          id: consoleId,
          workspaceId,
        },
      },
      {
        mongo: () =>
          this.mongo.recordConsoleExternalUse(
            workspaceId,
            consoleId,
            source,
            mode,
            now,
          ),
        pg: () =>
          this.pg.recordConsoleExternalUse(
            workspaceId,
            consoleId,
            source,
            mode,
            now,
          ),
      },
      res => res,
      false,
    );
  }

  guardedUpdateConsoleDescription(
    workspaceId: string,
    consoleId: string,
    expectedSourceBlobSha: string | null | undefined,
    patch: Pick<
      UpdateConsolePatch,
      | "description"
      | "descriptionSource"
      | "descriptionGeneratedAt"
      | "descriptionSourceSha"
      | "descriptionEmbedding"
      | "embeddingModel"
    >,
    updatedAt: Date = new Date(),
  ): Promise<boolean> {
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "guardedUpdateConsoleDescription",
        entityId: consoleId,
        retryPayload: {
          table: "saved_consoles",
          action: "upsert",
          id: consoleId,
          workspaceId,
        },
      },
      {
        mongo: () =>
          this.mongo.guardedUpdateConsoleDescription(
            workspaceId,
            consoleId,
            expectedSourceBlobSha,
            patch,
            updatedAt,
          ),
        pg: () =>
          this.pg.guardedUpdateConsoleDescription(
            workspaceId,
            consoleId,
            expectedSourceBlobSha,
            patch,
            updatedAt,
          ),
      },
      res => res,
      false,
    );
  }

  softDeleteConsole(
    workspaceId: string,
    consoleId: string,
    deletedAt: Date = new Date(),
    opts?: { onlyIfNotDeleted?: boolean },
  ): Promise<boolean> {
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "softDeleteConsole",
        entityId: consoleId,
        retryPayload: {
          table: "saved_consoles",
          action: "upsert",
          id: consoleId,
          workspaceId,
        },
      },
      {
        mongo: () =>
          this.mongo.softDeleteConsole(workspaceId, consoleId, deletedAt, opts),
        pg: () =>
          this.pg.softDeleteConsole(workspaceId, consoleId, deletedAt, opts),
      },
      res => res,
      false,
    );
  }

  restoreConsole(
    workspaceId: string,
    consoleId: string,
    patch?: { path?: string; sourceBlobSha?: string },
    updatedAt: Date = new Date(),
  ): Promise<boolean> {
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "restoreConsole",
        entityId: consoleId,
        retryPayload: {
          table: "saved_consoles",
          action: "upsert",
          id: consoleId,
          workspaceId,
        },
      },
      {
        mongo: () =>
          this.mongo.restoreConsole(workspaceId, consoleId, patch, updatedAt),
        pg: () =>
          this.pg.restoreConsole(workspaceId, consoleId, patch, updatedAt),
      },
      res => res,
      false,
    );
  }

  async deleteConsolesInFolder(
    workspaceId: string,
    folderId: string,
  ): Promise<number> {
    let deletedIds: string[] = [];
    const retryPayload: Record<string, unknown> = {
      table: "saved_consoles",
      action: "delete_in_folder",
      folderId,
      workspaceId,
    };
    const removed = await this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "deleteConsolesInFolder",
        entityId: folderId,
        retryPayload,
      },
      {
        mongo: async () => {
          const ids = await this.mongo.deleteConsolesInFolderReturningIds(
            workspaceId,
            folderId,
          );
          if (ids.length > 0 && deletedIds.length === 0) {
            deletedIds = ids;
            retryPayload.deletedIds = ids;
          }
          return ids.length;
        },
        pg: () => this.pg.deleteConsolesInFolder(workspaceId, folderId),
      },
      count => count > 0,
      0,
      { allowSecondaryNoop: true },
    );
    if (removed > 0 && deletedIds.length > 0) {
      await this.recordTombstonesIfDualWrite(
        workspaceId,
        "saved_consoles",
        deletedIds,
      );
    }
    return removed;
  }

  updateConsoleScheduleOutcome(
    input: RecordScheduleOutcomeInput,
  ): Promise<boolean> {
    const stamped: RecordScheduleOutcomeInput = {
      ...input,
      updatedAt: input.updatedAt ?? input.lastAt,
    };
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "updateConsoleScheduleOutcome",
        entityId: input.consoleId,
        retryPayload: {
          table: "saved_consoles",
          action: "upsert",
          id: input.consoleId,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.updateConsoleScheduleOutcome(stamped),
        pg: () => this.pg.updateConsoleScheduleOutcome(stamped),
      },
      res => res,
      false,
    );
  }

  clearConsoleSchedule(
    workspaceId: string,
    consoleId: string,
    patch?: { path?: string; sourceBlobSha?: string },
    updatedAt: Date = new Date(),
  ): Promise<boolean> {
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "clearConsoleSchedule",
        entityId: consoleId,
        retryPayload: {
          table: "saved_consoles",
          action: "upsert",
          id: consoleId,
          workspaceId,
        },
      },
      {
        mongo: () =>
          this.mongo.clearConsoleSchedule(
            workspaceId,
            consoleId,
            patch,
            updatedAt,
          ),
        pg: () =>
          this.pg.clearConsoleSchedule(
            workspaceId,
            consoleId,
            patch,
            updatedAt,
          ),
      },
      res => res,
      false,
    );
  }

  async findDueScheduledConsoles(now: Date): Promise<DueScheduledConsole[]> {
    if (await this.isGlobalPgOnly()) {
      return this.pg.findDueScheduledConsoles(now);
    }
    const mongoDue = await this.mongo.findDueScheduledConsoles(now);
    if (!(await this.hasAnyPgReadWorkspace())) {
      return mongoDue;
    }
    const pgDue = await this.pg.findDueScheduledConsoles(now);
    const merged = new Map<string, DueScheduledConsole>();
    for (const doc of mongoDue) {
      if (!(await this.isPgReadMode(doc.workspaceId))) {
        merged.set(doc.id, doc);
      }
    }
    for (const doc of pgDue) {
      if (await this.isPgReadMode(doc.workspaceId)) {
        merged.set(doc.id, doc);
      }
    }
    return [...merged.values()];
  }

  claimScheduledConsole(
    doc: DueScheduledConsole,
    nextAt: Date,
    updatedAt: Date = new Date(),
  ): Promise<{ modifiedCount: number }> {
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId: doc.workspaceId,
        operation: "claimScheduledConsole",
        entityId: doc.id,
        retryPayload: {
          table: "saved_consoles",
          action: "upsert",
          id: doc.id,
          workspaceId: doc.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.claimScheduledConsole(doc, nextAt, updatedAt),
        pg: () => this.pg.claimScheduledConsole(doc, nextAt, updatedAt),
      },
      res => res.modifiedCount > 0,
      { modifiedCount: 0 },
    );
  }

  async isPgVectorAvailable(): Promise<boolean> {
    if (this.isForceMongoOnly() || !this.hasPg()) return false;
    return this.pg.isPgVectorAvailable();
  }

  searchConsolesVector(
    workspaceId: string,
    queryEmbedding: number[],
    opts: { limit: number; embeddingModel?: string | null },
  ): Promise<ConsoleSearchCandidate[]> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "searchConsolesVector",
      },
      {
        mongo: () =>
          this.mongo.searchConsolesVector(workspaceId, queryEmbedding, opts),
        pg: () =>
          this.pg.searchConsolesVector(workspaceId, queryEmbedding, opts),
        canonicalize: results =>
          canonicalizeSearchResultsForCompare(results, opts.limit),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  searchConsolesText(
    workspaceId: string,
    query: string,
    opts: { limit: number },
  ): Promise<ConsoleSearchCandidate[]> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "searchConsolesText",
      },
      {
        mongo: () => this.mongo.searchConsolesText(workspaceId, query, opts),
        pg: () => this.pg.searchConsolesText(workspaceId, query, opts),
        canonicalize: results =>
          canonicalizeSearchResultsForCompare(results, opts.limit),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  searchConsolesName(
    workspaceId: string,
    query: string,
    opts: { limit: number },
  ): Promise<ConsoleSearchCandidate[]> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "searchConsolesName",
      },
      {
        mongo: () => this.mongo.searchConsolesName(workspaceId, query, opts),
        pg: () => this.pg.searchConsolesName(workspaceId, query, opts),
        canonicalize: results =>
          canonicalizeSearchResultsForCompare(results, opts.limit),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  // ── 3. Entity versions ────────────────────────────────────────────────

  async getLatestEntityVersionNumber(
    entityId: string,
    entityType: "console",
    workspaceId?: string,
  ): Promise<number> {
    if (workspaceId !== undefined && !isValidWorkspaceId(workspaceId)) {
      return 0;
    }
    if (workspaceId === undefined) {
      if (await this.isGlobalPgOnly()) {
        return this.pg.getLatestEntityVersionNumber(entityId, entityType);
      }
      if (await this.hasAnyPgReadWorkspace()) {
        const pgWs = await this.pg.findEntityVersionWorkspaceId(
          entityId,
          entityType,
        );
        if (pgWs && (await this.isPgReadMode(pgWs))) {
          return this.pg.getLatestEntityVersionNumber(
            entityId,
            entityType,
            pgWs,
          );
        }
        const mongoWs = await this.mongo.findEntityVersionWorkspaceId(
          entityId,
          entityType,
        );
        if (mongoWs && !(await this.isPgReadMode(mongoWs))) {
          return this.mongo.getLatestEntityVersionNumber(
            entityId,
            entityType,
            mongoWs,
          );
        }
        return 0;
      }
    }
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "getLatestEntityVersionNumber",
        entityId,
      },
      {
        mongo: () =>
          this.mongo.getLatestEntityVersionNumber(
            entityId,
            entityType,
            workspaceId,
          ),
        pg: () =>
          this.pg.getLatestEntityVersionNumber(
            entityId,
            entityType,
            workspaceId,
          ),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  async createEntityVersion(
    input: CreateEntityVersionInput,
  ): Promise<EntityVersionRecord> {
    let mintedId = input.id ?? newDualId().oid;
    const createdAt = input.createdAt ?? new Date();
    let mintedVersion = input.version;
    const retryPayload: Record<string, unknown> = {
      table: "entity_versions",
      action: "upsert",
      id: mintedId,
      workspaceId: input.workspaceId,
      entityId: input.entityId,
    };
    const created = await this.executeTrackedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "createEntityVersion",
        entityId: mintedId,
        retryPayload,
      },
      {
        mongo: async pgPrimary => {
          const savedBy = await this.resolveSingleMongoUserId(
            input.savedBy,
            pgPrimary,
          );
          const res = await this.mongo.createEntityVersion({
            ...input,
            savedBy,
            id: mintedId,
            createdAt,
            version: mintedVersion,
          });
          mintedId = res.id;
          mintedVersion = res.version;
          retryPayload.id = res.id;
          return res;
        },
        pg: async () => {
          const res = await this.pg.createEntityVersion({
            ...input,
            id: mintedId,
            createdAt,
            version: mintedVersion,
          });
          mintedId = res.id;
          mintedVersion = res.version;
          retryPayload.id = res.id;
          return res;
        },
      },
    );
    await this.clearTombstoneIfActive(
      input.workspaceId,
      "entity_versions",
      created.id,
    );
    return created;
  }

  async listEntityVersions(
    entityId: string,
    entityType: "console",
    opts?: { workspaceId?: string; limit?: number; offset?: number },
  ): Promise<{ versions: EntityVersionListItem[]; total: number }> {
    if (
      opts?.workspaceId !== undefined &&
      !isValidWorkspaceId(opts.workspaceId)
    ) {
      return { versions: [], total: 0 };
    }
    if (opts?.workspaceId === undefined) {
      if (await this.isGlobalPgOnly()) {
        return this.pg.listEntityVersions(entityId, entityType, opts);
      }
      if (await this.hasAnyPgReadWorkspace()) {
        const pgWs = await this.pg.findEntityVersionWorkspaceId(
          entityId,
          entityType,
        );
        if (pgWs && (await this.isPgReadMode(pgWs))) {
          return this.pg.listEntityVersions(entityId, entityType, {
            ...opts,
            workspaceId: pgWs,
          });
        }
        const mongoWs = await this.mongo.findEntityVersionWorkspaceId(
          entityId,
          entityType,
        );
        if (mongoWs && !(await this.isPgReadMode(mongoWs))) {
          return this.mongo.listEntityVersions(entityId, entityType, {
            ...opts,
            workspaceId: mongoWs,
          });
        }
        return { versions: [], total: 0 };
      }
    }
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId: opts?.workspaceId,
        operation: "listEntityVersions",
        entityId,
      },
      {
        mongo: () => this.mongo.listEntityVersions(entityId, entityType, opts),
        pg: () => this.pg.listEntityVersions(entityId, entityType, opts),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  listEntityVersionsAscending(
    workspaceId: string,
    entityId: string,
    entityType: "console",
  ): Promise<EntityVersionRecord[]> {
    if (!isValidWorkspaceId(workspaceId)) return Promise.resolve([]);
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "listEntityVersionsAscending",
        entityId,
      },
      {
        mongo: () =>
          this.mongo.listEntityVersionsAscending(
            workspaceId,
            entityId,
            entityType,
          ),
        pg: () =>
          this.pg.listEntityVersionsAscending(
            workspaceId,
            entityId,
            entityType,
          ),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  async getEntityVersion(
    entityId: string,
    entityType: "console",
    version: number,
    workspaceId?: string,
  ): Promise<EntityVersionRecord | null> {
    if (workspaceId !== undefined && !isValidWorkspaceId(workspaceId)) {
      return null;
    }
    if (workspaceId === undefined) {
      if (await this.isGlobalPgOnly()) {
        return this.pg.getEntityVersion(entityId, entityType, version);
      }
      if (await this.hasAnyPgReadWorkspace()) {
        const pgRow = await this.pg.getEntityVersion(
          entityId,
          entityType,
          version,
        );
        if (pgRow && (await this.isPgReadMode(pgRow.workspaceId))) {
          return pgRow;
        }
        const mongoRow = await this.mongo.getEntityVersion(
          entityId,
          entityType,
          version,
        );
        if (mongoRow && !(await this.isPgReadMode(mongoRow.workspaceId))) {
          return mongoRow;
        }
        return null;
      }
    }
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "getEntityVersion",
        entityId,
      },
      {
        mongo: () =>
          this.mongo.getEntityVersion(
            entityId,
            entityType,
            version,
            workspaceId,
          ),
        pg: () =>
          this.pg.getEntityVersion(entityId, entityType, version, workspaceId),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  countEntityVersions(
    workspaceId: string,
    entityType: "console",
    entityIds: readonly string[],
  ): Promise<number> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "countEntityVersions",
      },
      {
        mongo: () =>
          this.mongo.countEntityVersions(workspaceId, entityType, entityIds),
        pg: () =>
          this.pg.countEntityVersions(workspaceId, entityType, entityIds),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  // ── 4. Notebook folders ───────────────────────────────────────────────

  listNotebookFolders(
    workspaceId: string,
    opts?: { sortByName?: boolean },
  ): Promise<NotebookFolderRecord[]> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "listNotebookFolders",
      },
      {
        mongo: () => this.mongo.listNotebookFolders(workspaceId, opts),
        pg: () => this.pg.listNotebookFolders(workspaceId, opts),
        canonicalize: rows =>
          opts?.sortByName
            ? [...rows].sort((a, b) =>
                a.name < b.name
                  ? -1
                  : a.name > b.name
                    ? 1
                    : a.id.localeCompare(b.id),
              )
            : sortRecordsById(rows),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  findNotebookFolderById(
    workspaceId: string,
    folderId: string,
  ): Promise<NotebookFolderRecord | null> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "findNotebookFolderById",
        entityId: folderId,
      },
      {
        mongo: () => this.mongo.findNotebookFolderById(workspaceId, folderId),
        pg: () => this.pg.findNotebookFolderById(workspaceId, folderId),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  async createNotebookFolder(
    input: CreateNotebookFolderInput,
  ): Promise<NotebookFolderRecord> {
    const id = input.id ?? newDualId().oid;
    const createdAt = input.createdAt ?? new Date();
    const fullInput: CreateNotebookFolderInput = { ...input, id, createdAt };
    const created = await this.executeTrackedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "createNotebookFolder",
        entityId: id,
        retryPayload: {
          table: "notebook_folders",
          action: "upsert",
          id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: async pgPrimary => {
          const ownerId = await this.resolveSingleMongoUserId(
            fullInput.ownerId,
            pgPrimary,
          );
          return this.mongo.createNotebookFolder({ ...fullInput, ownerId });
        },
        pg: () => this.pg.createNotebookFolder(fullInput),
      },
    );
    await this.clearTombstoneIfActive(
      input.workspaceId,
      "notebook_folders",
      created.id,
    );
    return created;
  }

  updateNotebookFolder(
    workspaceId: string,
    folderId: string,
    patch: UpdateNotebookFolderInput,
  ): Promise<NotebookFolderRecord | null> {
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "updateNotebookFolder",
        entityId: folderId,
        retryPayload: {
          table: "notebook_folders",
          action: "upsert",
          id: folderId,
          workspaceId,
        },
      },
      {
        mongo: async pgPrimary => {
          const mappedPatch =
            pgPrimary && patch.ownerId !== undefined
              ? {
                  ...patch,
                  ownerId: await this.resolveSingleMongoUserId(
                    patch.ownerId,
                    pgPrimary,
                  ),
                }
              : patch;
          return this.mongo.updateNotebookFolder(
            workspaceId,
            folderId,
            mappedPatch,
          );
        },
        pg: () => this.pg.updateNotebookFolder(workspaceId, folderId, patch),
      },
      res => res !== null,
      null,
    );
  }

  async deleteNotebookFolderSubtree(
    workspaceId: string,
    folderId: string,
  ): Promise<boolean> {
    let deletedIds: string[] = [];
    const retryPayload: Record<string, unknown> = {
      table: "notebook_folders",
      action: "delete_subtree",
      id: folderId,
      workspaceId,
    };
    const deleted = await this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "deleteNotebookFolderSubtree",
        entityId: folderId,
        retryPayload,
      },
      {
        mongo: async () => {
          const ids = await this.mongo.deleteNotebookFolderSubtreeReturningIds(
            workspaceId,
            folderId,
          );
          if (ids.length > 0 && deletedIds.length === 0) {
            deletedIds = ids;
            retryPayload.deletedIds = ids;
          }
          return ids.length > 0;
        },
        pg: () => this.pg.deleteNotebookFolderSubtree(workspaceId, folderId),
      },
      res => res,
      false,
      { allowSecondaryNoop: true },
    );
    if (deleted && deletedIds.length > 0) {
      await this.recordTombstonesIfDualWrite(
        workspaceId,
        "notebook_folders",
        deletedIds,
      );
    }
    return deleted;
  }

  wouldCreateNotebookFolderCycle(
    workspaceId: string,
    folderId: string,
    targetParentId: string | null,
  ): Promise<boolean> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "wouldCreateNotebookFolderCycle",
        entityId: folderId,
      },
      {
        mongo: () =>
          this.mongo.wouldCreateNotebookFolderCycle(
            workspaceId,
            folderId,
            targetParentId,
          ),
        pg: () =>
          this.pg.wouldCreateNotebookFolderCycle(
            workspaceId,
            folderId,
            targetParentId,
          ),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  // ── 5. Notebook indexes ───────────────────────────────────────────────

  findNotebookIndex(
    workspaceId: string,
    notebookId: string,
  ): Promise<NotebookIndexRecord | null> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "findNotebookIndex",
        entityId: notebookId,
      },
      {
        mongo: () => this.mongo.findNotebookIndex(workspaceId, notebookId),
        pg: () => this.pg.findNotebookIndex(workspaceId, notebookId),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  findNotebookIndexByPath(
    workspaceId: string,
    path: string,
    opts?: { excludeNotebookId?: string },
  ): Promise<NotebookIndexRecord | null> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "findNotebookIndexByPath",
      },
      {
        mongo: () =>
          this.mongo.findNotebookIndexByPath(workspaceId, path, opts),
        pg: () => this.pg.findNotebookIndexByPath(workspaceId, path, opts),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  listNotebookIndexes(
    workspaceId: string,
    opts?: { sortByName?: boolean; visibleForUserId?: string },
  ): Promise<NotebookIndexRecord[]> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "listNotebookIndexes",
      },
      {
        mongo: async pgPrimary => {
          if (!pgPrimary || !opts?.visibleForUserId) {
            return this.mongo.listNotebookIndexes(workspaceId, opts);
          }
          const visibleForUserId = await this.resolveSingleMongoUserId(
            opts.visibleForUserId,
            pgPrimary,
          );
          return this.mongo.listNotebookIndexes(workspaceId, {
            ...opts,
            visibleForUserId,
          });
        },
        pg: () => this.pg.listNotebookIndexes(workspaceId, opts),
        canonicalize: rows =>
          opts?.sortByName
            ? [...rows].sort((a, b) =>
                a.name < b.name
                  ? -1
                  : a.name > b.name
                    ? 1
                    : a.id.localeCompare(b.id),
              )
            : sortRecordsById(rows),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  async createNotebookIndex(
    input: CreateNotebookIndexInput,
  ): Promise<NotebookIndexRecord> {
    const id = input.id ?? newDualId().oid;
    const updatedAt = input.updatedAt ?? new Date();
    const fullInput: CreateNotebookIndexInput = { ...input, id, updatedAt };
    const created = await this.executeTrackedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "createNotebookIndex",
        entityId: id,
        retryPayload: {
          table: "notebook_indexes",
          action: "upsert",
          id,
          workspaceId: input.workspaceId,
          notebookId: input.notebookId,
        },
      },
      {
        mongo: async pgPrimary => {
          if (!pgPrimary) return this.mongo.createNotebookIndex(fullInput);
          const legacyMap = await this.resolveMongoUserIdMap([
            fullInput.ownerId,
            ...(fullInput.sharedWith?.flatMap(s => [s.userId, s.addedBy]) ??
              []),
          ]);
          return this.mongo.createNotebookIndex({
            ...fullInput,
            ownerId: this.mapUserIdForMongo(fullInput.ownerId, legacyMap),
            sharedWith: this.mapShareEntriesForMongo(
              fullInput.sharedWith,
              legacyMap,
            ),
          });
        },
        pg: () => this.pg.createNotebookIndex(fullInput),
      },
    );
    await this.clearTombstoneIfActive(
      input.workspaceId,
      "notebook_indexes",
      created.id,
    );
    return created;
  }

  updateNotebookIndex(
    workspaceId: string,
    notebookId: string,
    patch: UpdateNotebookIndexInput,
  ): Promise<NotebookIndexRecord | null> {
    const stamped: UpdateNotebookIndexInput = {
      ...patch,
      updatedAt: patch.updatedAt ?? new Date(),
    };
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "updateNotebookIndex",
        entityId: notebookId,
        retryPayload: {
          table: "notebook_indexes",
          action: "upsert",
          workspaceId,
          notebookId,
        },
      },
      {
        mongo: async pgPrimary => {
          if (!pgPrimary || !stamped.sharedWith) {
            return this.mongo.updateNotebookIndex(
              workspaceId,
              notebookId,
              stamped,
            );
          }
          const legacyMap = await this.resolveMongoUserIdMap(
            stamped.sharedWith.flatMap(s => [s.userId, s.addedBy]),
          );
          return this.mongo.updateNotebookIndex(workspaceId, notebookId, {
            ...stamped,
            sharedWith: this.mapShareEntriesForMongo(
              stamped.sharedWith,
              legacyMap,
            ),
          });
        },
        pg: () => this.pg.updateNotebookIndex(workspaceId, notebookId, stamped),
      },
      res => res !== null,
      null,
    );
  }

  async deleteNotebookIndex(
    workspaceId: string,
    notebookId: string,
  ): Promise<boolean> {
    let deletedId: string | null = null;
    const retryPayload: Record<string, unknown> = {
      table: "notebook_indexes",
      action: "delete",
      workspaceId,
      notebookId,
    };
    const deleted = await this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "deleteNotebookIndex",
        entityId: notebookId,
        retryPayload,
      },
      {
        mongo: async () => {
          const id = await this.mongo.deleteNotebookIndexReturningId(
            workspaceId,
            notebookId,
          );
          if (id && !deletedId) {
            deletedId = id;
            retryPayload.deletedIds = [id];
          }
          return id !== null;
        },
        pg: () => this.pg.deleteNotebookIndex(workspaceId, notebookId),
      },
      res => res,
      false,
      { allowSecondaryNoop: true },
    );
    if (deleted && deletedId) {
      await this.recordTombstonesIfDualWrite(workspaceId, "notebook_indexes", [
        deletedId,
      ]);
    }
    return deleted;
  }

  // ── 6. Favourites ─────────────────────────────────────────────────────

  listFavourites(
    workspaceId: string,
    userId: string,
  ): Promise<FavouriteRecord[]> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "listFavourites",
      },
      {
        mongo: async pgPrimary =>
          this.mongo.listFavourites(
            workspaceId,
            await this.resolveSingleMongoUserId(userId, pgPrimary),
          ),
        pg: () => this.pg.listFavourites(workspaceId, userId),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  countFavourites(workspaceId: string, userId: string): Promise<number> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "countFavourites",
      },
      {
        mongo: async pgPrimary =>
          this.mongo.countFavourites(
            workspaceId,
            await this.resolveSingleMongoUserId(userId, pgPrimary),
          ),
        pg: () => this.pg.countFavourites(workspaceId, userId),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  findFavouriteById(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<FavouriteRecord | null> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "findFavouriteById",
        entityId: id,
      },
      {
        mongo: async pgPrimary =>
          this.mongo.findFavouriteById(
            workspaceId,
            await this.resolveSingleMongoUserId(userId, pgPrimary),
            id,
          ),
        pg: () => this.pg.findFavouriteById(workspaceId, userId, id),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  findFavouriteByRef(
    workspaceId: string,
    userId: string,
    kind: FavouriteKind,
    refId: string,
  ): Promise<FavouriteRecord | null> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "findFavouriteByRef",
      },
      {
        mongo: async pgPrimary =>
          this.mongo.findFavouriteByRef(
            workspaceId,
            await this.resolveSingleMongoUserId(userId, pgPrimary),
            kind,
            refId,
          ),
        pg: () => this.pg.findFavouriteByRef(workspaceId, userId, kind, refId),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  listFavouriteSiblings(
    workspaceId: string,
    userId: string,
    parentId: string | null,
    excludeId?: string,
  ): Promise<FavouriteRecord[]> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "listFavouriteSiblings",
      },
      {
        mongo: async pgPrimary =>
          this.mongo.listFavouriteSiblings(
            workspaceId,
            await this.resolveSingleMongoUserId(userId, pgPrimary),
            parentId,
            excludeId,
          ),
        pg: () =>
          this.pg.listFavouriteSiblings(
            workspaceId,
            userId,
            parentId,
            excludeId,
          ),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  getNextFavouritePosition(
    workspaceId: string,
    userId: string,
    parentId: string | null,
  ): Promise<number> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "getNextFavouritePosition",
      },
      {
        mongo: async pgPrimary =>
          this.mongo.getNextFavouritePosition(
            workspaceId,
            await this.resolveSingleMongoUserId(userId, pgPrimary),
            parentId,
          ),
        pg: () =>
          this.pg.getNextFavouritePosition(workspaceId, userId, parentId),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  createFavourite(input: CreateFavouriteInput): Promise<FavouriteRecord> {
    let mintedId = input.id ?? newDualId().oid;
    const now = new Date();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    const retryPayload: Record<string, unknown> = {
      table: "favourites",
      action: "upsert",
      id: mintedId,
      workspaceId: input.workspaceId,
    };
    return this.executeTrackedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "createFavourite",
        entityId: mintedId,
        retryPayload,
      },
      {
        mongo: async pgPrimary => {
          const mongoUserId = await this.resolveSingleMongoUserId(
            input.userId,
            pgPrimary,
          );
          const res = await this.mongo.createFavourite({
            ...input,
            userId: mongoUserId,
            id: mintedId,
            createdAt,
            updatedAt,
          });
          mintedId = res.id;
          retryPayload.id = res.id;
          return res;
        },
        pg: async () => {
          const res = await this.pg.createFavourite({
            ...input,
            id: mintedId,
            createdAt,
            updatedAt,
          });
          mintedId = res.id;
          retryPayload.id = res.id;
          return res;
        },
      },
    );
  }

  updateFavouriteSimple(
    workspaceId: string,
    userId: string,
    id: string,
    patch: {
      parentId?: string | null;
      position?: number;
      title?: string;
      updatedAt?: Date;
    },
  ): Promise<FavouriteRecord | null> {
    const stamped = { ...patch, updatedAt: patch.updatedAt ?? new Date() };
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "updateFavouriteSimple",
        entityId: id,
        retryPayload: {
          table: "favourites",
          action: "upsert",
          id,
          workspaceId,
        },
      },
      {
        mongo: async pgPrimary =>
          this.mongo.updateFavouriteSimple(
            workspaceId,
            await this.resolveSingleMongoUserId(userId, pgPrimary),
            id,
            stamped,
          ),
        pg: () =>
          this.pg.updateFavouriteSimple(workspaceId, userId, id, stamped),
      },
      res => res !== null,
      null,
    );
  }

  reorderFavourites(
    workspaceId: string,
    userId: string,
    updates: readonly ReorderFavouriteUpdate[],
    updatedAt: Date = new Date(),
  ): Promise<void> {
    if (updates.length === 0) return Promise.resolve();
    return this.executeTrackedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "reorderFavourites",
        entityId: updates[0]?.id ?? "batch",
        retryPayload: {
          table: "favourites",
          action: "reorder",
          workspaceId,
          userId,
          ids: updates.map(u => u.id),
        },
      },
      {
        mongo: async pgPrimary =>
          this.mongo.reorderFavourites(
            workspaceId,
            await this.resolveSingleMongoUserId(userId, pgPrimary),
            updates,
            updatedAt,
          ),
        pg: () =>
          this.pg.reorderFavourites(workspaceId, userId, updates, updatedAt),
      },
    );
  }

  async deleteFavouriteByRef(
    workspaceId: string,
    userId: string,
    kind: FavouriteKind,
    refId: string,
  ): Promise<boolean> {
    let deletedId: string | null = null;
    const retryPayload: Record<string, unknown> = {
      table: "favourites",
      action: "delete_by_ref",
      workspaceId,
      userId,
      kind,
      refId,
    };
    const removed = await this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "deleteFavouriteByRef",
        entityId: `${kind}:${refId}`,
        retryPayload,
      },
      {
        mongo: async pgPrimary => {
          const mongoUserId = await this.resolveSingleMongoUserId(
            userId,
            pgPrimary,
          );
          const id = await this.mongo.deleteFavouriteByRefReturningId(
            workspaceId,
            mongoUserId,
            kind,
            refId,
          );
          if (id && !deletedId) {
            deletedId = id;
            retryPayload.deletedIds = [id];
          }
          return id !== null;
        },
        pg: () =>
          this.pg.deleteFavouriteByRef(workspaceId, userId, kind, refId),
      },
      res => res,
      false,
      { allowSecondaryNoop: true },
    );
    if (removed && deletedId) {
      await this.recordTombstonesIfDualWrite(workspaceId, "favourites", [
        deletedId,
      ]);
    }
    return removed;
  }

  async deleteFavouriteSubtree(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<number> {
    let deletedIds: string[] = [];
    const retryPayload: Record<string, unknown> = {
      table: "favourites",
      action: "delete_subtree",
      workspaceId,
      userId,
      id,
    };
    const removed = await this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "deleteFavouriteSubtree",
        entityId: id,
        retryPayload,
      },
      {
        mongo: async pgPrimary => {
          const mongoUserId = await this.resolveSingleMongoUserId(
            userId,
            pgPrimary,
          );
          const ids = await this.mongo.deleteFavouriteSubtreeReturningIds(
            workspaceId,
            mongoUserId,
            id,
          );
          if (ids.length > 0 && deletedIds.length === 0) {
            deletedIds = ids;
            retryPayload.deletedIds = ids;
          }
          return ids.length;
        },
        pg: () => this.pg.deleteFavouriteSubtree(workspaceId, userId, id),
      },
      count => count > 0,
      0,
      { allowSecondaryNoop: true },
    );
    if (removed > 0 && deletedIds.length > 0) {
      await this.recordTombstonesIfDualWrite(
        workspaceId,
        "favourites",
        deletedIds,
      );
    }
    return removed;
  }

  // ── 7. Scheduled query runs ───────────────────────────────────────────

  createScheduledQueryRun(
    input: CreateScheduledQueryRunInput,
  ): Promise<ScheduledQueryRunRecord> {
    const id = input.id ?? newDualId().oid;
    const triggeredAt = input.triggeredAt ?? new Date();
    const fullInput: CreateScheduledQueryRunInput = {
      ...input,
      id,
      triggeredAt,
    };
    return this.executeTrackedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId: input.workspaceId,
        operation: "createScheduledQueryRun",
        entityId: id,
        retryPayload: {
          table: "scheduled_query_runs",
          action: "upsert",
          id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: async pgPrimary => {
          const triggeredBy = await this.resolveSingleMongoUserId(
            fullInput.triggeredBy,
            pgPrimary,
          );
          return this.mongo.createScheduledQueryRun({
            ...fullInput,
            triggeredBy,
          });
        },
        pg: () => this.pg.createScheduledQueryRun(fullInput),
      },
    );
  }

  async findScheduledQueryRunById(
    runId: string,
    workspaceId?: string,
  ): Promise<ScheduledQueryRunRecord | null> {
    if (workspaceId !== undefined && !isValidWorkspaceId(workspaceId)) {
      return null;
    }
    if (workspaceId === undefined) {
      if (await this.isGlobalPgOnly()) {
        return this.pg.findScheduledQueryRunById(runId);
      }
      if (await this.hasAnyPgReadWorkspace()) {
        const pgRow = await this.pg.findScheduledQueryRunById(runId);
        if (pgRow && (await this.isPgReadMode(pgRow.workspaceId))) {
          return pgRow;
        }
        const mongoRow = await this.mongo.findScheduledQueryRunById(runId);
        if (mongoRow && !(await this.isPgReadMode(mongoRow.workspaceId))) {
          return mongoRow;
        }
        return null;
      }
    }
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "findScheduledQueryRunById",
        entityId: runId,
      },
      {
        mongo: () => this.mongo.findScheduledQueryRunById(runId, workspaceId),
        pg: () => this.pg.findScheduledQueryRunById(runId, workspaceId),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  updateScheduledQueryRun(
    workspaceId: string,
    runId: string,
    patch: UpdateScheduledQueryRunInput,
  ): Promise<boolean> {
    if (!isValidWorkspaceId(workspaceId)) return Promise.resolve(false);
    return this.executeGatedWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "updateScheduledQueryRun",
        entityId: runId,
        retryPayload: {
          table: "scheduled_query_runs",
          action: "upsert",
          id: runId,
          workspaceId,
        },
      },
      {
        mongo: () =>
          this.mongo.updateScheduledQueryRun(workspaceId, runId, patch),
        pg: () => this.pg.updateScheduledQueryRun(workspaceId, runId, patch),
      },
      res => res,
      false,
    );
  }

  listScheduledQueryRuns(
    workspaceId: string,
    consoleId: string,
    limit: number,
  ): Promise<ScheduledQueryRunRecord[]> {
    return this.executeShadowRead(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "listScheduledQueryRuns",
        entityId: consoleId,
      },
      {
        mongo: () =>
          this.mongo.listScheduledQueryRuns(workspaceId, consoleId, limit),
        pg: () => this.pg.listScheduledQueryRuns(workspaceId, consoleId, limit),
        shadowOptions: CONSOLES_CHARTS_SHADOW_OPTIONS,
      },
    );
  }

  async purgeWorkspaceContentIndex(workspaceId: string): Promise<void> {
    if (!isValidWorkspaceId(workspaceId)) return;
    let deletedByTable: {
      saved_consoles: string[];
      console_folders: string[];
      entity_versions: string[];
      notebook_indexes: string[];
      notebook_folders: string[];
    } | null = null;
    const retryPayload: Record<string, unknown> = {
      table: "saved_consoles",
      action: "purge_workspace_index",
      workspaceId,
    };
    await this.router.executeWrite(
      {
        domain: CONSOLES_CHARTS_DOMAIN,
        workspaceId,
        operation: "purgeWorkspaceContentIndex",
        entityId: workspaceId,
        retryPayload,
      },
      {
        mongo: async () => {
          const ids =
            await this.mongo.purgeWorkspaceContentIndexReturningIds(
              workspaceId,
            );
          if (!deletedByTable) {
            deletedByTable = ids;
            retryPayload.deletedByTable = ids;
          }
        },
        pg: async () => {
          const ids =
            await this.pg.purgeWorkspaceContentIndexReturningIds(workspaceId);
          if (!deletedByTable) {
            deletedByTable = ids;
            retryPayload.deletedByTable = ids;
          }
        },
      },
    );
    if (deletedByTable) {
      const byTable = deletedByTable as {
        saved_consoles: string[];
        console_folders: string[];
        entity_versions: string[];
        notebook_indexes: string[];
        notebook_folders: string[];
      };
      for (const [tableName, ids] of Object.entries(byTable)) {
        if (ids.length > 0) {
          await this.recordTombstonesIfDualWrite(workspaceId, tableName, ids);
        }
      }
    }
  }
}
