/**
 * 5-stage workspace-scoped dual-run `UsageStatsRepository` powered by
 * `MigrationRouter` (`domain = "usage_stats"`).
 *
 * Key guarantees:
 *   - Mints ONE bijective dual ID (`newDualId()`) per newly created record so
 *     MongoDB `_id` and Postgres `id` stay 100% identical across dual-writes.
 *   - `app_feed_snapshots` skips backfill and provides a 24h PG -> Mongo read-fallback
 *     during Stage 4 (`dual_write_pg_read`) so in-flight home-feed cursors never 410.
 *   - Per-workspace Stage 4/5 canary safe: global scans (`getHotWorkspaceUsageSince`)
 *     and workspace-less `findFeedSnapshotById` partition across PG canary overrides
 *     when global mode still reads Mongo.
 *   - Off-critical-path Stage 3/4 shadow-compare resolves legacy 15-char Lucia user IDs
 *     via a single batch PG `users` query ONLY when a read is actually sampled (zero
 *     extra PG queries in `mongo_only`, `dual_write_mongo_read`, unsampled reads, or
 *     `pg_only`) and normalizes `"system"` sentinels <-> `null`.
 *   - `floatEpsilon: 1e-6` in shadow-compare for USD cost rollups (`numeric(14, 8)` vs JS float).
 *   - Secondary write failures never fail the primary request and enqueue dead-letter
 *     sync-retry payloads handled by `usage-stats.backfill.ts`.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  getPgDb,
  hasPostgresConfig,
  type MakoPgDb,
} from "../../database/pg/client";
import { isUuidString, newDualId, toWireId } from "../../database/pg/id-codec";
import { users } from "../../database/pg/schema/auth";
import {
  GLOBAL_SCOPE_KEY,
  migrationDomainState,
} from "../../database/pg/schema/control-plane";
import {
  isMigrationForceMongoOnly,
  migrationRouter,
  type MigrationRouter,
  type RouterOperationContext,
} from "../../migration/router";
import type { ShadowCompareOptions } from "../../migration/types";
import {
  canonicalizeDayRows,
  canonicalizeRollups,
  isAnonVisitorId,
} from "./mapper";
import { MongoUsageStatsRepository } from "./mongo.repo";
import { PgUsageStatsRepository } from "./pg.repo";
import type {
  AppFeedSnapshotRecord,
  AppUsageDayRowRecord,
  AppUsageEventRecord,
  AppUsageRollupRecord,
  BumpAppUsageDailyInput,
  ConnectionVerificationRecord,
  CreateAppFeedSnapshotInput,
  CreateAppUsageEventInput,
  CreateConnectionVerificationInput,
  CreateLlmUsageInput,
  CreateQueryExecutionInput,
  DateRangeFilter,
  HotWorkspaceUsageRecord,
  ListQueryExecutionsOptions,
  LlmUsageByModelRow,
  LlmUsageByUserRow,
  LlmUsageRecord,
  LlmUsageTotals,
  QueryExecutionRecord,
  RecentlyViewedAppRecord,
  SkillUsageAggregateRow,
  SkillUsageBumpKind,
  SkillUsageSourcePg,
  SkillUsageTargetInput,
  UnattributedWorkflowCall,
  UsageStatsRepository,
  WorkflowDailyCostRow,
  WorkflowRunBackfillPatch,
  WorkflowRunStepCostRow,
  WorkspaceQueryExecutionSummary,
} from "./types";

export const USAGE_STATS_DOMAIN = "usage_stats" as const;

export const USAGE_STATS_SHADOW_OPTIONS: ShadowCompareOptions = {
  floatEpsilon: 1e-6,
};

const SYSTEM_USER_SENTINELS = new Set(["", "system", "scheduler", "worker"]);

function isSystemSentinel(value: string | null | undefined): boolean {
  if (value == null) return true;
  return SYSTEM_USER_SENTINELS.has(value.trim());
}

function normalizeUsageUserId(
  raw: string | null | undefined,
  userMap: ReadonlyMap<string, string>,
): string | null {
  if (raw == null || isSystemSentinel(raw)) return null;
  if (isAnonVisitorId(raw as string | null)) return raw;
  const trimmed = raw.trim();
  const mapped = userMap.get(trimmed);
  if (mapped) return mapped;
  return isUuidString(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export interface DualUsageStatsRepositoryDeps {
  mongo?: MongoUsageStatsRepository;
  pg?: PgUsageStatsRepository;
  router?: MigrationRouter;
  getDb?: () => MakoPgDb;
}

export class DualUsageStatsRepository implements UsageStatsRepository {
  readonly mongo: MongoUsageStatsRepository;
  readonly pg: PgUsageStatsRepository;
  private readonly router: MigrationRouter;
  private readonly getDb: () => MakoPgDb;
  private readonly hasInjectedDb: boolean;

  constructor(deps: DualUsageStatsRepositoryDeps = {}) {
    this.mongo = deps.mongo ?? new MongoUsageStatsRepository();
    this.pg = deps.pg ?? new PgUsageStatsRepository({ getDb: deps.getDb });
    this.router = deps.router ?? migrationRouter;
    this.getDb = deps.getDb ?? getPgDb;
    this.hasInjectedDb = Boolean(deps.getDb);
  }

  private hasPgDb(): boolean {
    if (isMigrationForceMongoOnly()) return false;
    return this.hasInjectedDb || hasPostgresConfig();
  }

  /**
   * Return workspace wire IDs whose `usage_stats` override reads Postgres
   * (`dual_write_pg_read` or `pg_only`). Returns empty immediately when PG is
   * disabled or `MIGRATION_FORCE_MONGO_ONLY=true`.
   */
  private async getPgReadWorkspaceOverrides(): Promise<Set<string>> {
    if (!this.hasPgDb()) return new Set();
    try {
      const db = this.getDb();
      const rows = await db
        .select({ workspaceId: migrationDomainState.workspaceId })
        .from(migrationDomainState)
        .where(
          and(
            eq(migrationDomainState.domain, USAGE_STATS_DOMAIN),
            ne(migrationDomainState.scopeKey, GLOBAL_SCOPE_KEY),
            inArray(migrationDomainState.mode, [
              "dual_write_pg_read",
              "pg_only",
            ]),
          ),
        );
      const out = new Set<string>();
      for (const r of rows) {
        if (r.workspaceId) out.add(toWireId(r.workspaceId));
      }
      return out;
    } catch {
      return new Set();
    }
  }

  /**
   * Batch-resolve legacy / non-canonical user IDs against Postgres `users`.
   * Called strictly OFF the request critical path (inside sampled shadow reads).
   */
  private async resolveShadowUserMap(
    rawIds: readonly (string | null | undefined)[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const toLookup = new Set<string>();
    for (const raw of rawIds) {
      if (
        !raw ||
        isSystemSentinel(raw) ||
        isAnonVisitorId(raw as string | null)
      ) {
        continue;
      }
      const trimmed = raw.trim();
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
        // Stage 4 reverse-shadow: PG primary already ran; resolve legacy IDs now.
        if (pgCaptured) {
          await populateMap(res);
        }
        return res;
      },
      pg: async () => {
        const res = await handlers.pg();
        pgCaptured = true;
        // Stage 3 forward-shadow: Mongo primary already ran; resolve legacy IDs now.
        if (mongoCaptured && mongoValue !== undefined) {
          await populateMap(mongoValue);
        }
        return res;
      },
      canonicalize: value => handlers.canonicalize(value, shadowUserMap),
      shadowOptions: USAGE_STATS_SHADOW_OPTIONS,
    });
  }

  // ── app_usage_events & app_usage_daily ───────────────────────────────────

  createAppUsageEvent(
    input: CreateAppUsageEventInput,
  ): Promise<AppUsageEventRecord> {
    const id = input.id ?? newDualId().oid;
    const withId: CreateAppUsageEventInput = { ...input, id };
    return this.router.executeWrite(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "createAppUsageEvent",
        workspaceId: input.workspaceId,
        entityId: id,
        retryPayload: {
          table: "app_usage_events",
          id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.createAppUsageEvent(withId),
        pg: () => this.pg.createAppUsageEvent(withId),
      },
    );
  }

  bumpAppUsageDaily(input: BumpAppUsageDailyInput): Promise<void> {
    const id = input.id ?? newDualId().oid;
    const withId: BumpAppUsageDailyInput = { ...input, id };
    return this.router.executeWrite(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "bumpAppUsageDaily",
        workspaceId: input.workspaceId,
        entityId: `${input.workspaceId}:${input.appId}:${input.day}`,
        retryPayload: {
          table: "app_usage_daily",
          workspaceId: input.workspaceId,
          appId: input.appId,
          userId: input.userId,
          anonId: input.anonId ?? null,
          day: input.day,
        },
      },
      {
        mongo: () => this.mongo.bumpAppUsageDaily(withId),
        pg: () => this.pg.bumpAppUsageDaily(withId),
      },
    );
  }

  loadAppUsageRollups(
    workspaceId: string,
    sinceDay: string,
  ): Promise<AppUsageRollupRecord[]> {
    return this.executeUserResolvedRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "loadAppUsageRollups",
        workspaceId,
      },
      {
        mongo: () => this.mongo.loadAppUsageRollups(workspaceId, sinceDay),
        pg: () => this.pg.loadAppUsageRollups(workspaceId, sinceDay),
        collectRawUserIds: rows => rows.map(r => r.userId),
        canonicalize: (rows, userMap) =>
          canonicalizeRollups(
            rows.map(r => ({
              ...r,
              userId: normalizeUsageUserId(r.userId, userMap),
            })),
          ),
      },
    );
  }

  listAppUsageDaysSince(
    workspaceId: string,
    sinceDay: string,
  ): Promise<AppUsageDayRowRecord[]> {
    return this.executeUserResolvedRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "listAppUsageDaysSince",
        workspaceId,
      },
      {
        mongo: () => this.mongo.listAppUsageDaysSince(workspaceId, sinceDay),
        pg: () => this.pg.listAppUsageDaysSince(workspaceId, sinceDay),
        collectRawUserIds: rows => rows.map(r => r.userId),
        canonicalize: (rows, userMap) =>
          canonicalizeDayRows(
            rows.map(r => ({
              ...r,
              userId: normalizeUsageUserId(r.userId, userMap),
            })),
          ),
      },
    );
  }

  getRecentlyViewedApps(
    workspaceId: string,
    userId: string,
    since: Date,
    limit: number,
  ): Promise<RecentlyViewedAppRecord[]> {
    return this.router.executeRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "getRecentlyViewedApps",
        workspaceId,
      },
      {
        mongo: () =>
          this.mongo.getRecentlyViewedApps(workspaceId, userId, since, limit),
        pg: () =>
          this.pg.getRecentlyViewedApps(workspaceId, userId, since, limit),
        shadowOptions: USAGE_STATS_SHADOW_OPTIONS,
      },
    );
  }

  async getHotWorkspaceUsageSince(
    since: Date,
  ): Promise<HotWorkspaceUsageRecord[]> {
    const globalState = await this.router.getState(USAGE_STATS_DOMAIN);
    if (
      globalState.mode !== "dual_write_pg_read" &&
      globalState.mode !== "pg_only"
    ) {
      const pgOverrides = await this.getPgReadWorkspaceOverrides();
      if (pgOverrides.size > 0) {
        const [mongoRows, pgRows] = await Promise.all([
          this.mongo.getHotWorkspaceUsageSince(since),
          this.pg.getHotWorkspaceUsageSince(since),
        ]);
        return [
          ...mongoRows.filter(r => !pgOverrides.has(r.workspaceId)),
          ...pgRows.filter(r => pgOverrides.has(r.workspaceId)),
        ];
      }
    }

    return this.router.executeRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "getHotWorkspaceUsageSince",
      },
      {
        mongo: () => this.mongo.getHotWorkspaceUsageSince(since),
        pg: () => this.pg.getHotWorkspaceUsageSince(since),
        canonicalize: rows =>
          [...rows].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
        shadowOptions: USAGE_STATS_SHADOW_OPTIONS,
      },
    );
  }

  findEarliestAppUsageDay(workspaceId: string): Promise<string | null> {
    return this.router.executeRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "findEarliestAppUsageDay",
        workspaceId,
      },
      {
        mongo: () => this.mongo.findEarliestAppUsageDay(workspaceId),
        pg: () => this.pg.findEarliestAppUsageDay(workspaceId),
        shadowOptions: USAGE_STATS_SHADOW_OPTIONS,
      },
    );
  }

  // ── app_feed_snapshots (skip backfill; 24h PG->Mongo fallback in Stage 4) ─

  createFeedSnapshot(input: CreateAppFeedSnapshotInput): Promise<string> {
    const id = input.id ?? newDualId().oid;
    const withId: CreateAppFeedSnapshotInput = {
      ...input,
      id,
      createdAt: input.createdAt ?? new Date(),
    };
    return this.router.executeWrite(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "createFeedSnapshot",
        workspaceId: input.workspaceId,
        entityId: id,
        retryPayload: {
          table: "app_feed_snapshots",
          id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.createFeedSnapshot(withId),
        pg: () => this.pg.createFeedSnapshot(withId),
      },
    );
  }

  async findFeedSnapshotById(
    id: string,
    workspaceId?: string,
    now: Date = new Date(),
  ): Promise<AppFeedSnapshotRecord | null> {
    if (!workspaceId) {
      const globalState = await this.router.getState(USAGE_STATS_DOMAIN);
      if (
        globalState.mode !== "dual_write_pg_read" &&
        globalState.mode !== "pg_only"
      ) {
        const pgOverrides = await this.getPgReadWorkspaceOverrides();
        if (pgOverrides.size > 0) {
          const fromPg = await this.pg.findFeedSnapshotById(id, undefined, now);
          if (fromPg && pgOverrides.has(fromPg.workspaceId)) {
            return fromPg;
          }
          const fromMongo = await this.mongo.findFeedSnapshotById(
            id,
            undefined,
            now,
          );
          if (fromMongo && pgOverrides.has(fromMongo.workspaceId)) {
            const wsState = await this.router.getState(
              USAGE_STATS_DOMAIN,
              fromMongo.workspaceId,
            );
            return wsState.mode === "dual_write_pg_read" ? fromMongo : null;
          }
          return fromMongo;
        }
      }
    }

    const state = await this.router.getState(USAGE_STATS_DOMAIN, workspaceId);

    // Stage 4 cutover safety: `app_feed_snapshots` is ephemeral (24h TTL) and NOT
    // backfilled, so in-flight home-feed cursors created just before flipping to
    // `dual_write_pg_read` fall back cleanly to Mongo if missing in PG.
    if (state.mode === "dual_write_pg_read") {
      const fromPg = await this.pg.findFeedSnapshotById(id, workspaceId, now);
      if (fromPg) return fromPg;
      return this.mongo.findFeedSnapshotById(id, workspaceId, now);
    }

    return this.executeUserResolvedRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "findFeedSnapshotById",
        workspaceId,
        entityId: id,
      },
      {
        mongo: () => this.mongo.findFeedSnapshotById(id, workspaceId, now),
        pg: () => this.pg.findFeedSnapshotById(id, workspaceId, now),
        collectRawUserIds: rec => (rec ? [rec.userId] : []),
        canonicalize: (rec, userMap) => {
          if (!rec) return null;
          const resolved = normalizeUsageUserId(rec.userId, userMap);
          return {
            ...rec,
            ...(resolved ? { userId: resolved } : { userId: undefined }),
          };
        },
      },
    );
  }

  // ── skill_usage_daily ────────────────────────────────────────────────────

  bumpSkillUsageDaily(
    workspaceId: string,
    targets: readonly SkillUsageTargetInput[],
    kind: SkillUsageBumpKind,
    source: SkillUsageSourcePg,
    at: Date = new Date(),
  ): Promise<void> {
    if (targets.length === 0) return Promise.resolve();
    const ids = targets.map(() => newDualId().oid);
    const day = at.toISOString().slice(0, 10);
    return this.router.executeWrite(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "bumpSkillUsageDaily",
        workspaceId,
        entityId: `${workspaceId}:${day}`,
        retryPayload: {
          table: "skill_usage_daily",
          workspaceId,
          day,
          source,
          targets: targets.map(t => ({ scope: t.scope, skill: t.skill })),
        },
      },
      {
        mongo: () =>
          this.mongo.bumpSkillUsageDaily(
            workspaceId,
            targets,
            kind,
            source,
            at,
            ids,
          ),
        pg: () =>
          this.pg.bumpSkillUsageDaily(
            workspaceId,
            targets,
            kind,
            source,
            at,
            ids,
          ),
      },
    );
  }

  getSkillUsageSummary(
    workspaceId: string,
    sinceDay: string,
  ): Promise<SkillUsageAggregateRow[]> {
    return this.router.executeRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "getSkillUsageSummary",
        workspaceId,
      },
      {
        mongo: () => this.mongo.getSkillUsageSummary(workspaceId, sinceDay),
        pg: () => this.pg.getSkillUsageSummary(workspaceId, sinceDay),
        canonicalize: rows =>
          [...rows].sort((a, b) =>
            `${a.scope}:${a.skill}`.localeCompare(`${b.scope}:${b.skill}`),
          ),
        shadowOptions: USAGE_STATS_SHADOW_OPTIONS,
      },
    );
  }

  // ── llm_usage ────────────────────────────────────────────────────────────

  createLlmUsage(input: CreateLlmUsageInput): Promise<LlmUsageRecord> {
    const id = input.id ?? newDualId().oid;
    const withId: CreateLlmUsageInput = {
      ...input,
      id,
      createdAt: input.createdAt ?? new Date(),
    };
    return this.router.executeWrite(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "createLlmUsage",
        workspaceId: input.workspaceId,
        entityId: id,
        retryPayload: {
          table: "llm_usage",
          id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.createLlmUsage(withId),
        pg: () => this.pg.createLlmUsage(withId),
      },
    );
  }

  getWorkspaceLlmUsageSummary(
    workspaceId: string,
    range?: DateRangeFilter,
  ): Promise<LlmUsageTotals> {
    return this.router.executeRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "getWorkspaceLlmUsageSummary",
        workspaceId,
      },
      {
        mongo: () => this.mongo.getWorkspaceLlmUsageSummary(workspaceId, range),
        pg: () => this.pg.getWorkspaceLlmUsageSummary(workspaceId, range),
        shadowOptions: USAGE_STATS_SHADOW_OPTIONS,
      },
    );
  }

  getWorkspaceLlmUsageByUser(
    workspaceId: string,
    range?: DateRangeFilter,
  ): Promise<LlmUsageByUserRow[]> {
    return this.executeUserResolvedRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "getWorkspaceLlmUsageByUser",
        workspaceId,
      },
      {
        mongo: () => this.mongo.getWorkspaceLlmUsageByUser(workspaceId, range),
        pg: () => this.pg.getWorkspaceLlmUsageByUser(workspaceId, range),
        collectRawUserIds: rows => rows.map(r => r.userId),
        canonicalize: (rows, userMap) => {
          const merged = new Map<string, LlmUsageByUserRow>();
          for (const row of rows) {
            const normUser = normalizeUsageUserId(row.userId, userMap);
            const key = normUser ?? "\u0000null";
            const existing = merged.get(key);
            if (existing) {
              existing.totalInputTokens += row.totalInputTokens;
              existing.totalOutputTokens += row.totalOutputTokens;
              existing.totalCacheReadTokens += row.totalCacheReadTokens;
              existing.totalCacheWriteTokens += row.totalCacheWriteTokens;
              existing.totalReasoningTokens += row.totalReasoningTokens;
              existing.totalTokens += row.totalTokens;
              existing.totalCostUsd += row.totalCostUsd;
              existing.invocationCount += row.invocationCount;
            } else {
              merged.set(key, { ...row, userId: normUser });
            }
          }
          return [...merged.values()].sort((a, b) =>
            (a.userId ?? "").localeCompare(b.userId ?? ""),
          );
        },
      },
    );
  }

  getWorkspaceLlmUsageByModel(
    workspaceId: string,
    range?: DateRangeFilter,
  ): Promise<LlmUsageByModelRow[]> {
    return this.router.executeRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "getWorkspaceLlmUsageByModel",
        workspaceId,
      },
      {
        mongo: () => this.mongo.getWorkspaceLlmUsageByModel(workspaceId, range),
        pg: () => this.pg.getWorkspaceLlmUsageByModel(workspaceId, range),
        canonicalize: rows =>
          [...rows].sort((a, b) =>
            (a.modelId ?? "").localeCompare(b.modelId ?? ""),
          ),
        shadowOptions: USAGE_STATS_SHADOW_OPTIONS,
      },
    );
  }

  listLlmUsageByChat(
    workspaceId: string,
    chatId: string,
  ): Promise<LlmUsageRecord[]> {
    return this.executeUserResolvedRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "listLlmUsageByChat",
        workspaceId,
        entityId: chatId,
      },
      {
        mongo: () => this.mongo.listLlmUsageByChat(workspaceId, chatId),
        pg: () => this.pg.listLlmUsageByChat(workspaceId, chatId),
        collectRawUserIds: rows => rows.map(r => r.userId),
        canonicalize: (rows, userMap) =>
          rows.map(r => ({
            ...r,
            userId: normalizeUsageUserId(r.userId, userMap),
          })),
      },
    );
  }

  readWorkflowRunCosts(
    workspaceId: string,
    runIds: readonly string[],
  ): Promise<WorkflowRunStepCostRow[]> {
    return this.router.executeRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "readWorkflowRunCosts",
        workspaceId,
      },
      {
        mongo: () => this.mongo.readWorkflowRunCosts(workspaceId, runIds),
        pg: () => this.pg.readWorkflowRunCosts(workspaceId, runIds),
        canonicalize: rows =>
          [...rows].sort((a, b) =>
            `${a.runId}:${a.step ?? ""}`.localeCompare(
              `${b.runId}:${b.step ?? ""}`,
            ),
          ),
        shadowOptions: USAGE_STATS_SHADOW_OPTIONS,
      },
    );
  }

  readWorkflowDailyCosts(
    workspaceId: string,
    workflowId: string,
    since: Date,
  ): Promise<WorkflowDailyCostRow[]> {
    return this.router.executeRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "readWorkflowDailyCosts",
        workspaceId,
      },
      {
        mongo: () =>
          this.mongo.readWorkflowDailyCosts(workspaceId, workflowId, since),
        pg: () =>
          this.pg.readWorkflowDailyCosts(workspaceId, workflowId, since),
        shadowOptions: USAGE_STATS_SHADOW_OPTIONS,
      },
    );
  }

  listUnattributedWorkflowCalls(
    workspaceId: string,
    since: Date,
  ): Promise<UnattributedWorkflowCall[]> {
    return this.router.executeRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "listUnattributedWorkflowCalls",
        workspaceId,
      },
      {
        mongo: () =>
          this.mongo.listUnattributedWorkflowCalls(workspaceId, since),
        pg: () => this.pg.listUnattributedWorkflowCalls(workspaceId, since),
        canonicalize: rows =>
          [...rows].sort((a, b) => a.id.localeCompare(b.id)),
        shadowOptions: USAGE_STATS_SHADOW_OPTIONS,
      },
    );
  }

  attachWorkflowRunToCalls(
    workspaceId: string,
    patches: readonly WorkflowRunBackfillPatch[],
  ): Promise<number> {
    if (patches.length === 0) return Promise.resolve(0);
    return this.router.executeWrite(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "attachWorkflowRunToCalls",
        workspaceId,
        entityId: patches[0].id,
        retryPayload: {
          table: "llm_usage",
          workspaceId,
          ids: patches.map(p => p.id),
        },
      },
      {
        mongo: () => this.mongo.attachWorkflowRunToCalls(workspaceId, patches),
        pg: () => this.pg.attachWorkflowRunToCalls(workspaceId, patches),
      },
    );
  }

  // ── query_executions ─────────────────────────────────────────────────────

  createQueryExecution(
    input: CreateQueryExecutionInput,
  ): Promise<QueryExecutionRecord> {
    const id = input.id ?? newDualId().oid;
    const withId: CreateQueryExecutionInput = {
      ...input,
      id,
      executedAt: input.executedAt ?? new Date(),
    };
    return this.router.executeWrite(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "createQueryExecution",
        workspaceId: input.workspaceId,
        entityId: id,
        retryPayload: {
          table: "query_executions",
          id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.createQueryExecution(withId),
        pg: () => this.pg.createQueryExecution(withId),
      },
    );
  }

  listWorkspaceQueryExecutions(
    workspaceId: string,
    options?: ListQueryExecutionsOptions,
  ): Promise<{ executions: QueryExecutionRecord[]; total: number }> {
    return this.executeUserResolvedRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "listWorkspaceQueryExecutions",
        workspaceId,
      },
      {
        mongo: () =>
          this.mongo.listWorkspaceQueryExecutions(workspaceId, options),
        pg: () => this.pg.listWorkspaceQueryExecutions(workspaceId, options),
        collectRawUserIds: res => res.executions.map(e => e.userId),
        canonicalize: (res, userMap) => ({
          total: res.total,
          executions: res.executions.map(e => ({
            ...e,
            userId: normalizeUsageUserId(e.userId, userMap),
          })),
        }),
      },
    );
  }

  listConsoleQueryExecutions(
    workspaceId: string,
    consoleId: string,
    limit?: number,
  ): Promise<QueryExecutionRecord[]> {
    return this.executeUserResolvedRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "listConsoleQueryExecutions",
        workspaceId,
        entityId: consoleId,
      },
      {
        mongo: () =>
          this.mongo.listConsoleQueryExecutions(workspaceId, consoleId, limit),
        pg: () =>
          this.pg.listConsoleQueryExecutions(workspaceId, consoleId, limit),
        collectRawUserIds: rows => rows.map(r => r.userId),
        canonicalize: (rows, userMap) =>
          rows.map(r => ({
            ...r,
            userId: normalizeUsageUserId(r.userId, userMap),
          })),
      },
    );
  }

  getWorkspaceQueryExecutionSummary(
    workspaceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<WorkspaceQueryExecutionSummary> {
    return this.executeUserResolvedRead(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "getWorkspaceQueryExecutionSummary",
        workspaceId,
      },
      {
        mongo: () =>
          this.mongo.getWorkspaceQueryExecutionSummary(
            workspaceId,
            startDate,
            endDate,
          ),
        pg: () =>
          this.pg.getWorkspaceQueryExecutionSummary(
            workspaceId,
            startDate,
            endDate,
          ),
        collectRawUserIds: res => Object.keys(res.byUser),
        canonicalize: (res, userMap) => {
          const normalizedByUser: Record<string, number> = {};
          for (const [rawKey, count] of Object.entries(res.byUser)) {
            const norm = normalizeUsageUserId(rawKey, userMap) ?? "system";
            normalizedByUser[norm] = (normalizedByUser[norm] ?? 0) + count;
          }
          return {
            ...res,
            byUser: normalizedByUser,
          };
        },
      },
    );
  }

  // ── connection_verifications ─────────────────────────────────────────────

  createConnectionVerification(
    input: CreateConnectionVerificationInput,
  ): Promise<ConnectionVerificationRecord> {
    const id = input.id ?? newDualId().oid;
    const withId: CreateConnectionVerificationInput = {
      ...input,
      id,
      verifiedAt: input.verifiedAt ?? new Date(),
    };
    return this.router.executeWrite(
      {
        domain: USAGE_STATS_DOMAIN,
        operation: "createConnectionVerification",
        workspaceId: input.workspaceId ?? null,
        entityId: id,
        retryPayload: {
          table: "connection_verifications",
          id,
          workspaceId: input.workspaceId,
        },
      },
      {
        mongo: () => this.mongo.createConnectionVerification(withId),
        pg: () => this.pg.createConnectionVerification(withId),
      },
    );
  }
}
