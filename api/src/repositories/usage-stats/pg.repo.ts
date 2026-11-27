/**
 * Postgres (Neon / Drizzle) implementation of `UsageStatsRepository`.
 *
 * Highlights:
 *   - Atomic SQL `INSERT ... ON CONFLICT DO UPDATE` for `app_usage_daily` & `skill_usage_daily`.
 *   - Immutable `visitor_key` dedupe column on `app_usage_daily` so `DELETE FROM users`
 *     (`ON DELETE SET NULL` on `user_id`) NEVER triggers `23505`.
 *   - Native SQL aggregations replacing every Mongo `.aggregate()` pipeline in
 *     `routes/usage.ts`, `workflows/costs.ts`, `query-execution.service.ts`,
 *     `app-usage.service.ts`, and `skill-usage.service.ts`.
 *   - Read-time 24h TTL guard on `app_feed_snapshots`.
 *   - Idempotent `GREATEST(...)` backfill helpers for closed UTC days so `$inc` counters
 *     never double-count on retries.
 */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
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
import { databaseConnections } from "../../database/pg/schema/connections";
import { workspaceApiKeys } from "../../database/pg/schema/workspaces";
import {
  appFeedSnapshots,
  appUsageDaily,
  appUsageEvents,
  connectionVerifications,
  llmUsage,
  queryExecutions,
  skillUsageDaily,
} from "../../database/pg/schema/usage-stats";
import {
  APP_FEED_SNAPSHOT_TTL_MS,
  buildPgDailyViewerColumns,
  costUsdToPgNumeric,
  entityIdToPgUuid,
  isAnonVisitorId,
  optionalEntityIdToPgUuid,
  pgAppFeedSnapshotToRecord,
  pgAppUsageDailyToDayRow,
  pgAppUsageEventToRecord,
  pgConnectionVerificationToRecord,
  pgLlmUsageToRecord,
  pgNumericToNumber,
  pgQueryExecutionToRecord,
  visitorKeyToWireUserId,
} from "./mapper";
import type {
  AppFeedSnapshotRecord,
  AppUsageDailyRecord,
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
  QueryExecutionSourcePg,
  RecentlyViewedAppRecord,
  SkillUsageAggregateRow,
  SkillUsageBumpKind,
  SkillUsageDailyRecord,
  SkillUsageScopePg,
  SkillUsageSourcePg,
  SkillUsageTargetInput,
  UnattributedWorkflowCall,
  UsageStatsRepository,
  WorkflowDailyCostRow,
  WorkflowRunBackfillPatch,
  WorkflowRunStepCostRow,
  WorkspaceQueryExecutionSummary,
} from "./types";

const SYSTEM_USER_SENTINELS = new Set([
  "",
  "system",
  "worker",
  "publish",
  "api-key",
  "scheduler",
  "app-chat",
]);

export class PgUsageStatsRepository implements UsageStatsRepository {
  private readonly getDb: () => MakoPgDb;

  constructor(options: { getDb?: () => MakoPgDb } = {}) {
    this.getDb = options.getDb ?? getPgDb;
  }

  /**
   * Resolve a raw user ID (UUIDv7, legacy Lucia/UUIDv4 ID, or system sentinel) to
   * a valid Postgres `users.id` UUID, returning `null` for sentinels or missing users.
   */
  async resolveNullableUserUuid(
    rawUserId: string | null | undefined,
    db: MakoPgDb = this.getDb(),
  ): Promise<string | null> {
    if (!rawUserId) return null;
    const trimmed = rawUserId.trim();
    if (
      !trimmed ||
      SYSTEM_USER_SENTINELS.has(trimmed) ||
      isAnonVisitorId(trimmed as string | null)
    ) {
      return null;
    }
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
   * Verify `apiKeyId` exists in `workspace_api_keys` before inserting into `query_executions`
   * so telemetry for deleted keys cleanly stores `NULL` rather than failing FK `23503`.
   */
  private async resolveExistingApiKeyUuid(
    apiKeyId: string | null | undefined,
    db: MakoPgDb = this.getDb(),
  ): Promise<string | null> {
    const uuid = optionalEntityIdToPgUuid(apiKeyId);
    if (!uuid) return null;
    const rows = await db
      .select({ id: workspaceApiKeys.id })
      .from(workspaceApiKeys)
      .where(eq(workspaceApiKeys.id, uuid))
      .limit(1);
    return rows[0] ? rows[0].id.toLowerCase() : null;
  }

  /**
   * Verify `connectionId` exists in `database_connections` before inserting into
   * `connection_verifications` so telemetry for deleted connections cleanly stores
   * `NULL` rather than failing FK `23503` after `0006a` attaches the FK.
   */
  private async resolveExistingConnectionUuid(
    connectionId: string | null | undefined,
    db: MakoPgDb = this.getDb(),
  ): Promise<string | null> {
    const uuid = optionalEntityIdToPgUuid(connectionId);
    if (!uuid) return null;
    const rows = await db
      .select({ id: databaseConnections.id })
      .from(databaseConnections)
      .where(eq(databaseConnections.id, uuid))
      .limit(1);
    return rows[0] ? rows[0].id.toLowerCase() : null;
  }

  // ── app_usage_events & app_usage_daily ───────────────────────────────────

  async createAppUsageEvent(
    input: CreateAppUsageEventInput,
    db: MakoPgDb = this.getDb(),
    options: { overwrite?: boolean } = {},
  ): Promise<AppUsageEventRecord> {
    const idUuid = input.id ? entityIdToPgUuid(input.id) : newDualId().uuid;
    const wsUuid = entityIdToPgUuid(input.workspaceId);
    const appUuid = entityIdToPgUuid(input.appId);
    const resolvedUserUuid = await this.resolveNullableUserUuid(
      input.userId,
      db,
    );
    const anonId = resolvedUserUuid
      ? null
      : isAnonVisitorId(input.userId)
        ? input.userId
        : (input.anonId ?? null);

    const values: typeof appUsageEvents.$inferInsert = {
      id: idUuid,
      workspaceId: wsUuid,
      appId: appUuid,
      at: input.at,
      kind: input.kind,
      source: input.source,
      userId: resolvedUserUuid,
      anonId,
      sessionId: input.sessionId ?? null,
      referrerKind: input.referrerKind ?? null,
      uaClass: input.uaClass,
      throttled: input.throttled ?? null,
      placement: input.placement ?? null,
      backfill: input.backfill ?? null,
    };

    const insertQuery = db.insert(appUsageEvents).values(values);
    const rows = options.overwrite
      ? await insertQuery
          .onConflictDoUpdate({
            target: appUsageEvents.id,
            set: {
              workspaceId: values.workspaceId,
              appId: values.appId,
              at: values.at,
              kind: values.kind,
              source: values.source,
              userId: values.userId,
              anonId: values.anonId,
              sessionId: values.sessionId,
              referrerKind: values.referrerKind,
              uaClass: values.uaClass,
              throttled: values.throttled,
              placement: values.placement,
              backfill: values.backfill,
            },
          })
          .returning()
      : await insertQuery
          .onConflictDoNothing({ target: appUsageEvents.id })
          .returning();

    if (rows[0]) {
      return pgAppUsageEventToRecord(rows[0]);
    }
    const existing = await db
      .select()
      .from(appUsageEvents)
      .where(eq(appUsageEvents.id, idUuid))
      .limit(1);
    if (!existing[0]) {
      throw new Error(`Failed to insert app_usage_events row ${idUuid}`);
    }
    return pgAppUsageEventToRecord(existing[0]);
  }

  async bumpAppUsageDaily(
    input: BumpAppUsageDailyInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const idUuid = input.id ? entityIdToPgUuid(input.id) : newDualId().uuid;
    const wsUuid = entityIdToPgUuid(input.workspaceId);
    const appUuid = entityIdToPgUuid(input.appId);
    const resolvedUserUuid = await this.resolveNullableUserUuid(
      input.userId,
      db,
    );
    const viewer = buildPgDailyViewerColumns({
      rawUserId: input.userId,
      rawAnonId: input.anonId,
      resolvedPgUserUuid: resolvedUserUuid,
    });

    const opensInc = input.kind === "open" ? 1 : 0;
    const activeSecInc =
      input.kind === "heartbeat" ? (input.heartbeatSeconds ?? 60) : 0;
    const srcAppInc = input.kind === "open" && input.source === "app" ? 1 : 0;
    const srcShareInc =
      input.kind === "open" && input.source === "share" ? 1 : 0;
    const srcEmbedInc =
      input.kind === "open" && input.source === "embed" ? 1 : 0;

    await db
      .insert(appUsageDaily)
      .values({
        id: idUuid,
        workspaceId: wsUuid,
        appId: appUuid,
        userId: viewer.userId,
        anonId: viewer.anonId,
        visitorKey: viewer.visitorKey,
        day: input.day,
        opens: opensInc,
        activeSeconds: activeSecInc,
        sourcesApp: srcAppInc,
        sourcesShare: srcShareInc,
        sourcesEmbed: srcEmbedInc,
        firstAt: input.at,
        lastAt: input.at,
      })
      .onConflictDoUpdate({
        target: [
          appUsageDaily.workspaceId,
          appUsageDaily.appId,
          appUsageDaily.visitorKey,
          appUsageDaily.day,
        ],
        set: {
          opens: sql`${appUsageDaily.opens} + ${opensInc}`,
          activeSeconds: sql`${appUsageDaily.activeSeconds} + ${activeSecInc}`,
          sourcesApp: sql`${appUsageDaily.sourcesApp} + ${srcAppInc}`,
          sourcesShare: sql`${appUsageDaily.sourcesShare} + ${srcShareInc}`,
          sourcesEmbed: sql`${appUsageDaily.sourcesEmbed} + ${srcEmbedInc}`,
          firstAt: sql`LEAST(${appUsageDaily.firstAt}, ${input.at.toISOString()}::timestamptz)`,
          lastAt: sql`GREATEST(${appUsageDaily.lastAt}, ${input.at.toISOString()}::timestamptz)`,
        },
      });
  }

  /**
   * Closed-UTC-day backfill upsert using `GREATEST(...)` so concurrent retries
   * NEVER double-count counters.
   */
  async upsertAppUsageDailyClosedDay(
    record: AppUsageDailyRecord,
    resolvedPgUserUuid: string | null,
    options: { overwrite?: boolean; db?: MakoPgDb } = {},
  ): Promise<boolean> {
    const db = options.db ?? this.getDb();
    const idUuid = entityIdToPgUuid(record.id);
    const wsUuid = entityIdToPgUuid(record.workspaceId);
    const appUuid = entityIdToPgUuid(record.appId);
    const viewer = buildPgDailyViewerColumns({
      rawUserId: record.userId,
      resolvedPgUserUuid,
    });
    const sourcesApp = record.sources.app ?? 0;
    const sourcesShare = record.sources.share ?? 0;
    const sourcesEmbed = record.sources.embed ?? 0;
    const firstAtIso = record.firstAt.toISOString();
    const lastAtIso = record.lastAt.toISOString();

    const setValues = options.overwrite
      ? {
          id: idUuid,
          opens: record.opens,
          activeSeconds: record.activeSeconds,
          sourcesApp,
          sourcesShare,
          sourcesEmbed,
          firstAt: record.firstAt,
          lastAt: record.lastAt,
        }
      : {
          id: idUuid,
          opens: sql`GREATEST(${appUsageDaily.opens}, ${record.opens})`,
          activeSeconds: sql`GREATEST(${appUsageDaily.activeSeconds}, ${record.activeSeconds})`,
          sourcesApp: sql`GREATEST(${appUsageDaily.sourcesApp}, ${sourcesApp})`,
          sourcesShare: sql`GREATEST(${appUsageDaily.sourcesShare}, ${sourcesShare})`,
          sourcesEmbed: sql`GREATEST(${appUsageDaily.sourcesEmbed}, ${sourcesEmbed})`,
          firstAt: sql`LEAST(${appUsageDaily.firstAt}, ${firstAtIso}::timestamptz)`,
          lastAt: sql`GREATEST(${appUsageDaily.lastAt}, ${lastAtIso}::timestamptz)`,
        };

    const rows = await db
      .insert(appUsageDaily)
      .values({
        id: idUuid,
        workspaceId: wsUuid,
        appId: appUuid,
        userId: viewer.userId,
        anonId: viewer.anonId,
        visitorKey: viewer.visitorKey,
        day: record.day,
        opens: record.opens,
        activeSeconds: record.activeSeconds,
        sourcesApp,
        sourcesShare,
        sourcesEmbed,
        firstAt: record.firstAt,
        lastAt: record.lastAt,
      })
      .onConflictDoUpdate({
        target: [
          appUsageDaily.workspaceId,
          appUsageDaily.appId,
          appUsageDaily.visitorKey,
          appUsageDaily.day,
        ],
        set: setValues,
      })
      .returning({ id: appUsageDaily.id });
    return rows.length > 0;
  }

  async loadAppUsageRollups(
    workspaceId: string,
    sinceDay: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppUsageRollupRecord[]> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const rawResult = await db.execute(sql`
      SELECT
        "app_id",
        CASE
          WHEN "visitor_key" = 'anon' THEN NULL
          WHEN "visitor_key" LIKE 'u:%' THEN substring("visitor_key" FROM 3)
          ELSE "visitor_key"
        END AS "user_id",
        array_agg(DISTINCT to_char("day", 'YYYY-MM-DD') ORDER BY to_char("day", 'YYYY-MM-DD')) AS "days",
        COALESCE(SUM("opens"), 0)::int AS "opens",
        COALESCE(SUM("active_seconds"), 0)::int AS "active_seconds",
        MAX("last_at") AS "last_at"
      FROM "app_usage_daily"
      WHERE "workspace_id" = ${wsUuid}::uuid
        AND "day" >= ${sinceDay}::date
      GROUP BY "app_id", "visitor_key"
    `);
    const rows = extractRows<{
      app_id: string;
      user_id: string | null;
      days: string[];
      opens: number | string;
      active_seconds: number | string;
      last_at: Date | string;
    }>(rawResult);

    return rows.map(row => ({
      appId: toWireId(row.app_id),
      userId: row.user_id ?? null,
      days: Array.isArray(row.days) ? row.days : [],
      opens: Number(row.opens ?? 0),
      activeSeconds: Number(row.active_seconds ?? 0),
      lastAt: row.last_at instanceof Date ? row.last_at : new Date(row.last_at),
    }));
  }

  async listAppUsageDaysSince(
    workspaceId: string,
    sinceDay: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppUsageDayRowRecord[]> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const rows = await db
      .select({
        appId: appUsageDaily.appId,
        visitorKey: appUsageDaily.visitorKey,
        day: appUsageDaily.day,
        opens: appUsageDaily.opens,
        activeSeconds: appUsageDaily.activeSeconds,
        lastAt: appUsageDaily.lastAt,
      })
      .from(appUsageDaily)
      .where(
        and(
          eq(appUsageDaily.workspaceId, wsUuid),
          gte(appUsageDaily.day, sinceDay),
        ),
      );
    return rows.map(pgAppUsageDailyToDayRow);
  }

  async getRecentlyViewedApps(
    workspaceId: string,
    userId: string,
    since: Date,
    limit: number,
    db: MakoPgDb = this.getDb(),
  ): Promise<RecentlyViewedAppRecord[]> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const resolvedUserUuid = await this.resolveNullableUserUuid(userId, db);
    if (!resolvedUserUuid) return [];

    const rawResult = await db.execute(sql`
      SELECT "app_id", MAX("last_at") AS "last_at"
      FROM "app_usage_daily"
      WHERE "workspace_id" = ${wsUuid}::uuid
        AND "user_id" = ${resolvedUserUuid}::uuid
        AND "last_at" >= ${since.toISOString()}::timestamptz
      GROUP BY "app_id"
      ORDER BY MAX("last_at") DESC
      LIMIT ${limit}
    `);
    const rows = extractRows<{ app_id: string; last_at: Date | string }>(
      rawResult,
    );
    return rows.map(r => ({
      appId: toWireId(r.app_id),
      lastOpenedAt: r.last_at instanceof Date ? r.last_at : new Date(r.last_at),
    }));
  }

  async getHotWorkspaceUsageSince(
    since: Date,
    db: MakoPgDb = this.getDb(),
  ): Promise<HotWorkspaceUsageRecord[]> {
    const rawResult = await db.execute(sql`
      SELECT "workspace_id", MAX("last_at") AS "at"
      FROM "app_usage_daily"
      WHERE "last_at" >= ${since.toISOString()}::timestamptz
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

  async findEarliestAppUsageDay(
    workspaceId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<string | null> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const rows = await db
      .select({ day: appUsageDaily.day })
      .from(appUsageDaily)
      .where(eq(appUsageDaily.workspaceId, wsUuid))
      .orderBy(asc(appUsageDaily.day))
      .limit(1);
    return rows[0]?.day ?? null;
  }

  // ── app_feed_snapshots ───────────────────────────────────────────────────

  async createFeedSnapshot(
    input: CreateAppFeedSnapshotInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<string> {
    const dual = input.id
      ? { oid: input.id, uuid: entityIdToPgUuid(input.id) }
      : newDualId();
    const wsUuid = entityIdToPgUuid(input.workspaceId);
    const resolvedUserUuid = await this.resolveNullableUserUuid(
      input.userId,
      db,
    );

    await db
      .insert(appFeedSnapshots)
      .values({
        id: dual.uuid,
        workspaceId: wsUuid,
        userId: resolvedUserUuid,
        popular: [...input.popular],
        fresh: [...input.fresh],
        recommended: [...input.recommended],
        createdAt: input.createdAt ?? new Date(),
      })
      .onConflictDoNothing({ target: appFeedSnapshots.id });

    return toWireId(dual.uuid);
  }

  async findFeedSnapshotById(
    id: string,
    _workspaceId?: string,
    now: Date = new Date(),
    db: MakoPgDb = this.getDb(),
  ): Promise<AppFeedSnapshotRecord | null> {
    const parsed = parseEntityId(id);
    if (!parsed) return null;
    const cutoff = new Date(now.getTime() - APP_FEED_SNAPSHOT_TTL_MS);
    const rows = await db
      .select()
      .from(appFeedSnapshots)
      .where(
        and(
          eq(appFeedSnapshots.id, parsed.uuid),
          gte(appFeedSnapshots.createdAt, cutoff),
        ),
      )
      .limit(1);
    return rows[0] ? pgAppFeedSnapshotToRecord(rows[0]) : null;
  }

  // ── skill_usage_daily ────────────────────────────────────────────────────

  async bumpSkillUsageDaily(
    workspaceId: string,
    targets: readonly SkillUsageTargetInput[],
    kind: SkillUsageBumpKind,
    source: SkillUsageSourcePg,
    at: Date = new Date(),
    ids?: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    if (targets.length === 0) return;
    const wsUuid = entityIdToPgUuid(workspaceId);
    const day = at.toISOString().slice(0, 10);
    const loadsInc = kind === "load" ? 1 : 0;
    const readsInc = kind === "resource" ? 1 : 0;
    const hitsInc = kind === "relevant" ? 1 : 0;
    const atIso = at.toISOString();

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const idUuid = ids?.[i] ? entityIdToPgUuid(ids[i]) : newDualId().uuid;
      await db
        .insert(skillUsageDaily)
        .values({
          id: idUuid,
          workspaceId: wsUuid,
          scope: target.scope,
          skill: target.skill,
          source,
          day,
          loads: loadsInc,
          resourceReads: readsInc,
          relevantHits: hitsInc,
          firstAt: at,
          lastAt: at,
        })
        .onConflictDoUpdate({
          target: [
            skillUsageDaily.workspaceId,
            skillUsageDaily.scope,
            skillUsageDaily.skill,
            skillUsageDaily.source,
            skillUsageDaily.day,
          ],
          set: {
            loads: sql`${skillUsageDaily.loads} + ${loadsInc}`,
            resourceReads: sql`${skillUsageDaily.resourceReads} + ${readsInc}`,
            relevantHits: sql`${skillUsageDaily.relevantHits} + ${hitsInc}`,
            firstAt: sql`LEAST(${skillUsageDaily.firstAt}, ${atIso}::timestamptz)`,
            lastAt: sql`GREATEST(${skillUsageDaily.lastAt}, ${atIso}::timestamptz)`,
          },
        });
    }
  }

  /**
   * Closed-UTC-day backfill upsert using `GREATEST(...)` so concurrent retries
   * NEVER double-count counters.
   */
  async upsertSkillUsageDailyClosedDay(
    record: SkillUsageDailyRecord,
    options: { overwrite?: boolean; db?: MakoPgDb } = {},
  ): Promise<boolean> {
    const db = options.db ?? this.getDb();
    const idUuid = entityIdToPgUuid(record.id);
    const wsUuid = entityIdToPgUuid(record.workspaceId);
    const firstAtIso = record.firstAt.toISOString();
    const lastAtIso = record.lastAt.toISOString();

    const setValues = options.overwrite
      ? {
          id: idUuid,
          loads: record.loads,
          resourceReads: record.resourceReads,
          relevantHits: record.relevantHits,
          firstAt: record.firstAt,
          lastAt: record.lastAt,
        }
      : {
          id: idUuid,
          loads: sql`GREATEST(${skillUsageDaily.loads}, ${record.loads})`,
          resourceReads: sql`GREATEST(${skillUsageDaily.resourceReads}, ${record.resourceReads})`,
          relevantHits: sql`GREATEST(${skillUsageDaily.relevantHits}, ${record.relevantHits})`,
          firstAt: sql`LEAST(${skillUsageDaily.firstAt}, ${firstAtIso}::timestamptz)`,
          lastAt: sql`GREATEST(${skillUsageDaily.lastAt}, ${lastAtIso}::timestamptz)`,
        };

    const rows = await db
      .insert(skillUsageDaily)
      .values({
        id: idUuid,
        workspaceId: wsUuid,
        scope: record.scope,
        skill: record.skill,
        source: record.source,
        day: record.day,
        loads: record.loads,
        resourceReads: record.resourceReads,
        relevantHits: record.relevantHits,
        firstAt: record.firstAt,
        lastAt: record.lastAt,
      })
      .onConflictDoUpdate({
        target: [
          skillUsageDaily.workspaceId,
          skillUsageDaily.scope,
          skillUsageDaily.skill,
          skillUsageDaily.source,
          skillUsageDaily.day,
        ],
        set: setValues,
      })
      .returning({ id: skillUsageDaily.id });
    return rows.length > 0;
  }

  async getSkillUsageSummary(
    workspaceId: string,
    sinceDay: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<SkillUsageAggregateRow[]> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const rawResult = await db.execute(sql`
      SELECT
        "scope",
        "skill",
        COALESCE(
          SUM("loads" + "resource_reads" + "relevant_hits") FILTER (WHERE "day" >= ${sinceDay}::date),
          0
        )::int AS "loads30d",
        MAX("last_at") AS "last_loaded_at"
      FROM "skill_usage_daily"
      WHERE "workspace_id" = ${wsUuid}::uuid
      GROUP BY "scope", "skill"
    `);
    const rows = extractRows<{
      scope: SkillUsageScopePg;
      skill: string;
      loads30d: number | string;
      last_loaded_at: Date | string | null;
    }>(rawResult);
    return rows.map(row => ({
      scope: row.scope,
      skill: row.skill,
      loads30d: Number(row.loads30d ?? 0),
      lastLoadedAt: row.last_loaded_at
        ? row.last_loaded_at instanceof Date
          ? row.last_loaded_at
          : new Date(row.last_loaded_at)
        : null,
    }));
  }

  // ── llm_usage ────────────────────────────────────────────────────────────

  async createLlmUsage(
    input: CreateLlmUsageInput,
    db: MakoPgDb = this.getDb(),
    options: { overwrite?: boolean } = {},
  ): Promise<LlmUsageRecord> {
    const idUuid = input.id ? entityIdToPgUuid(input.id) : newDualId().uuid;
    const wsUuid = entityIdToPgUuid(input.workspaceId);
    const userUuid = await this.resolveNullableUserUuid(input.userId, db);
    const chatUuid = optionalEntityIdToPgUuid(input.chatId);

    const values: typeof llmUsage.$inferInsert = {
      id: idUuid,
      workspaceId: wsUuid,
      userId: userUuid,
      chatId: chatUuid,
      invocationType: input.invocationType,
      modelId: input.modelId,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      reasoningTokens: input.reasoningTokens ?? 0,
      totalTokens: input.totalTokens,
      costUsd: costUsdToPgNumeric(input.costUsd),
      steps: input.steps ?? null,
      agentId: input.agentId ?? null,
      tags: input.tags ?? null,
      durationMs: input.durationMs ?? null,
      workflowId: input.workflowRun?.workflowId ?? null,
      workflowRunId: input.workflowRun?.runId ?? null,
      workflowStep: input.workflowRun?.step ?? null,
      workflowBackfilled: input.workflowRun?.backfilled ?? null,
      createdAt: input.createdAt ?? new Date(),
    };

    const setClause = options.overwrite
      ? {
          workspaceId: values.workspaceId,
          userId: values.userId,
          chatId: values.chatId,
          invocationType: values.invocationType,
          modelId: values.modelId,
          inputTokens: values.inputTokens,
          outputTokens: values.outputTokens,
          cacheReadTokens: values.cacheReadTokens,
          cacheWriteTokens: values.cacheWriteTokens,
          reasoningTokens: values.reasoningTokens,
          totalTokens: values.totalTokens,
          costUsd: values.costUsd,
          steps: values.steps,
          agentId: values.agentId,
          tags: values.tags,
          durationMs: values.durationMs,
          workflowId: values.workflowId,
          workflowRunId: values.workflowRunId,
          workflowStep: values.workflowStep,
          workflowBackfilled: values.workflowBackfilled,
          createdAt: values.createdAt,
        }
      : {
          workflowId: sql`COALESCE(EXCLUDED."workflow_id", ${llmUsage.workflowId})`,
          workflowRunId: sql`COALESCE(EXCLUDED."workflow_run_id", ${llmUsage.workflowRunId})`,
          workflowStep: sql`COALESCE(EXCLUDED."workflow_step", ${llmUsage.workflowStep})`,
          workflowBackfilled: sql`COALESCE(EXCLUDED."workflow_backfilled", ${llmUsage.workflowBackfilled})`,
        };

    const rows = await db
      .insert(llmUsage)
      .values(values)
      .onConflictDoUpdate({
        target: llmUsage.id,
        set: setClause,
      })
      .returning();

    return pgLlmUsageToRecord(rows[0]);
  }

  private buildLlmRangeSql(range?: DateRangeFilter) {
    const parts = [];
    if (range?.from) {
      parts.push(
        sql`AND "created_at" >= ${range.from.toISOString()}::timestamptz`,
      );
    }
    if (range?.to) {
      parts.push(
        sql`AND "created_at" <= ${range.to.toISOString()}::timestamptz`,
      );
    }
    return parts.length > 0 ? sql.join(parts, sql` `) : sql``;
  }

  async getWorkspaceLlmUsageSummary(
    workspaceId: string,
    range?: DateRangeFilter,
    db: MakoPgDb = this.getDb(),
  ): Promise<LlmUsageTotals> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const rangeSql = this.buildLlmRangeSql(range);
    const rawResult = await db.execute(sql`
      SELECT
        COALESCE(SUM("input_tokens"), 0)::bigint AS "total_input_tokens",
        COALESCE(SUM("output_tokens"), 0)::bigint AS "total_output_tokens",
        COALESCE(SUM("cache_read_tokens"), 0)::bigint AS "total_cache_read_tokens",
        COALESCE(SUM("cache_write_tokens"), 0)::bigint AS "total_cache_write_tokens",
        COALESCE(SUM("reasoning_tokens"), 0)::bigint AS "total_reasoning_tokens",
        COALESCE(SUM("total_tokens"), 0)::bigint AS "total_tokens",
        COALESCE(SUM("cost_usd"), 0) AS "total_cost_usd",
        COUNT(*)::int AS "invocation_count"
      FROM "llm_usage"
      WHERE "workspace_id" = ${wsUuid}::uuid
        ${rangeSql}
    `);
    const row = extractRows<{
      total_input_tokens: string | number;
      total_output_tokens: string | number;
      total_cache_read_tokens: string | number;
      total_cache_write_tokens: string | number;
      total_reasoning_tokens: string | number;
      total_tokens: string | number;
      total_cost_usd: string | number;
      invocation_count: string | number;
    }>(rawResult)[0];
    return {
      totalInputTokens: Number(row?.total_input_tokens ?? 0),
      totalOutputTokens: Number(row?.total_output_tokens ?? 0),
      totalCacheReadTokens: Number(row?.total_cache_read_tokens ?? 0),
      totalCacheWriteTokens: Number(row?.total_cache_write_tokens ?? 0),
      totalReasoningTokens: Number(row?.total_reasoning_tokens ?? 0),
      totalTokens: Number(row?.total_tokens ?? 0),
      totalCostUsd: pgNumericToNumber(row?.total_cost_usd),
      invocationCount: Number(row?.invocation_count ?? 0),
    };
  }

  async getWorkspaceLlmUsageByUser(
    workspaceId: string,
    range?: DateRangeFilter,
    db: MakoPgDb = this.getDb(),
  ): Promise<LlmUsageByUserRow[]> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const rangeSql = this.buildLlmRangeSql(range);
    const rawResult = await db.execute(sql`
      SELECT
        "user_id",
        COALESCE(SUM("input_tokens"), 0)::bigint AS "total_input_tokens",
        COALESCE(SUM("output_tokens"), 0)::bigint AS "total_output_tokens",
        COALESCE(SUM("cache_read_tokens"), 0)::bigint AS "total_cache_read_tokens",
        COALESCE(SUM("cache_write_tokens"), 0)::bigint AS "total_cache_write_tokens",
        COALESCE(SUM("reasoning_tokens"), 0)::bigint AS "total_reasoning_tokens",
        COALESCE(SUM("total_tokens"), 0)::bigint AS "total_tokens",
        COALESCE(SUM("cost_usd"), 0) AS "total_cost_usd",
        COUNT(*)::int AS "invocation_count"
      FROM "llm_usage"
      WHERE "workspace_id" = ${wsUuid}::uuid
        ${rangeSql}
      GROUP BY "user_id"
      ORDER BY COALESCE(SUM("cost_usd"), 0) DESC
    `);
    const rows = extractRows<{
      user_id: string | null;
      total_input_tokens: string | number;
      total_output_tokens: string | number;
      total_cache_read_tokens: string | number;
      total_cache_write_tokens: string | number;
      total_reasoning_tokens: string | number;
      total_tokens: string | number;
      total_cost_usd: string | number;
      invocation_count: string | number;
    }>(rawResult);
    return rows.map(row => ({
      userId: row.user_id ? row.user_id.toLowerCase() : null,
      totalInputTokens: Number(row.total_input_tokens ?? 0),
      totalOutputTokens: Number(row.total_output_tokens ?? 0),
      totalCacheReadTokens: Number(row.total_cache_read_tokens ?? 0),
      totalCacheWriteTokens: Number(row.total_cache_write_tokens ?? 0),
      totalReasoningTokens: Number(row.total_reasoning_tokens ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
      totalCostUsd: pgNumericToNumber(row.total_cost_usd),
      invocationCount: Number(row.invocation_count ?? 0),
    }));
  }

  async getWorkspaceLlmUsageByModel(
    workspaceId: string,
    range?: DateRangeFilter,
    db: MakoPgDb = this.getDb(),
  ): Promise<LlmUsageByModelRow[]> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const rangeSql = this.buildLlmRangeSql(range);
    const rawResult = await db.execute(sql`
      SELECT
        "model_id",
        COALESCE(SUM("input_tokens"), 0)::bigint AS "total_input_tokens",
        COALESCE(SUM("output_tokens"), 0)::bigint AS "total_output_tokens",
        COALESCE(SUM("cache_read_tokens"), 0)::bigint AS "total_cache_read_tokens",
        COALESCE(SUM("cache_write_tokens"), 0)::bigint AS "total_cache_write_tokens",
        COALESCE(SUM("reasoning_tokens"), 0)::bigint AS "total_reasoning_tokens",
        COALESCE(SUM("total_tokens"), 0)::bigint AS "total_tokens",
        COALESCE(SUM("cost_usd"), 0) AS "total_cost_usd",
        COUNT(*)::int AS "invocation_count"
      FROM "llm_usage"
      WHERE "workspace_id" = ${wsUuid}::uuid
        ${rangeSql}
      GROUP BY "model_id"
      ORDER BY COALESCE(SUM("cost_usd"), 0) DESC
    `);
    const rows = extractRows<{
      model_id: string | null;
      total_input_tokens: string | number;
      total_output_tokens: string | number;
      total_cache_read_tokens: string | number;
      total_cache_write_tokens: string | number;
      total_reasoning_tokens: string | number;
      total_tokens: string | number;
      total_cost_usd: string | number;
      invocation_count: string | number;
    }>(rawResult);
    return rows.map(row => ({
      modelId: row.model_id ?? null,
      totalInputTokens: Number(row.total_input_tokens ?? 0),
      totalOutputTokens: Number(row.total_output_tokens ?? 0),
      totalCacheReadTokens: Number(row.total_cache_read_tokens ?? 0),
      totalCacheWriteTokens: Number(row.total_cache_write_tokens ?? 0),
      totalReasoningTokens: Number(row.total_reasoning_tokens ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
      totalCostUsd: pgNumericToNumber(row.total_cost_usd),
      invocationCount: Number(row.invocation_count ?? 0),
    }));
  }

  async listLlmUsageByChat(
    workspaceId: string,
    chatId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<LlmUsageRecord[]> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const chatUuid = entityIdToPgUuid(chatId);
    const rows = await db
      .select()
      .from(llmUsage)
      .where(
        and(eq(llmUsage.workspaceId, wsUuid), eq(llmUsage.chatId, chatUuid)),
      )
      .orderBy(asc(llmUsage.createdAt));
    return rows.map(pgLlmUsageToRecord);
  }

  async readWorkflowRunCosts(
    workspaceId: string,
    runIds: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<WorkflowRunStepCostRow[]> {
    if (runIds.length === 0) return [];
    const wsUuid = entityIdToPgUuid(workspaceId);
    const runIdLiterals = sql.join(
      runIds.map(id => sql`${id}`),
      sql`, `,
    );
    const rawResult = await db.execute(sql`
      SELECT
        "workflow_run_id" AS "run_id",
        "workflow_step" AS "step",
        COALESCE(SUM("cost_usd"), 0) AS "cost_usd",
        COALESCE(SUM("input_tokens"), 0)::bigint AS "input_tokens",
        COALESCE(SUM("output_tokens"), 0)::bigint AS "output_tokens",
        COUNT(*)::int AS "calls",
        BOOL_OR(COALESCE("workflow_backfilled", false)) AS "backfilled"
      FROM "llm_usage"
      WHERE "workspace_id" = ${wsUuid}::uuid
        AND "workflow_run_id" IN (${runIdLiterals})
      GROUP BY "workflow_run_id", "workflow_step"
    `);
    const rows = extractRows<{
      run_id: string;
      step: string | null;
      cost_usd: string | number;
      input_tokens: string | number;
      output_tokens: string | number;
      calls: string | number;
      backfilled: boolean;
    }>(rawResult);
    return rows.map(r => ({
      runId: r.run_id,
      step: r.step ?? null,
      costUsd: pgNumericToNumber(r.cost_usd),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      calls: Number(r.calls ?? 0),
      backfilled: Boolean(r.backfilled),
    }));
  }

  async readWorkflowDailyCosts(
    workspaceId: string,
    workflowId: string,
    since: Date,
    db: MakoPgDb = this.getDb(),
  ): Promise<WorkflowDailyCostRow[]> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const rawResult = await db.execute(sql`
      SELECT
        to_char(("created_at" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS "day",
        COALESCE(SUM("cost_usd"), 0) AS "cost_usd",
        array_agg(DISTINCT "workflow_run_id" ORDER BY "workflow_run_id") FILTER (WHERE "workflow_run_id" IS NOT NULL) AS "run_ids"
      FROM "llm_usage"
      WHERE "workspace_id" = ${wsUuid}::uuid
        AND "workflow_id" = ${workflowId}
        AND "created_at" >= ${since.toISOString()}::timestamptz
      GROUP BY ("created_at" AT TIME ZONE 'UTC')::date
      ORDER BY ("created_at" AT TIME ZONE 'UTC')::date ASC
    `);
    const rows = extractRows<{
      day: string;
      cost_usd: string | number;
      run_ids: string[] | null;
    }>(rawResult);
    return rows.map(r => ({
      day: r.day,
      costUsd: pgNumericToNumber(r.cost_usd),
      runIds: Array.isArray(r.run_ids) ? r.run_ids : [],
    }));
  }

  async listUnattributedWorkflowCalls(
    workspaceId: string,
    since: Date,
    db: MakoPgDb = this.getDb(),
  ): Promise<UnattributedWorkflowCall[]> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const rows = await db
      .select({
        id: llmUsage.id,
        createdAt: llmUsage.createdAt,
        durationMs: llmUsage.durationMs,
        costUsd: llmUsage.costUsd,
      })
      .from(llmUsage)
      .where(
        and(
          eq(llmUsage.workspaceId, wsUuid),
          eq(llmUsage.invocationType, "workflow"),
          isNull(llmUsage.workflowRunId),
          gte(llmUsage.createdAt, since),
        ),
      );
    return rows.map(r => ({
      id: toWireId(r.id),
      endedAt: r.createdAt.getTime(),
      ...(r.durationMs != null ? { durationMs: r.durationMs } : {}),
      costUsd: pgNumericToNumber(r.costUsd),
    }));
  }

  async attachWorkflowRunToCalls(
    workspaceId: string,
    patches: readonly WorkflowRunBackfillPatch[],
    db: MakoPgDb = this.getDb(),
  ): Promise<number> {
    if (patches.length === 0) return 0;
    const wsUuid = entityIdToPgUuid(workspaceId);
    let updated = 0;
    for (const patch of patches) {
      const idUuid = entityIdToPgUuid(patch.id);
      const rows = await db
        .update(llmUsage)
        .set({
          workflowId: patch.workflowId,
          workflowRunId: patch.runId,
          workflowStep: patch.step,
          workflowBackfilled: true,
        })
        .where(
          and(
            eq(llmUsage.id, idUuid),
            eq(llmUsage.workspaceId, wsUuid),
            isNull(llmUsage.workflowRunId),
          ),
        )
        .returning({ id: llmUsage.id });
      updated += rows.length;
    }
    return updated;
  }

  // ── query_executions ─────────────────────────────────────────────────────

  async createQueryExecution(
    input: CreateQueryExecutionInput,
    db: MakoPgDb = this.getDb(),
    options: { overwrite?: boolean } = {},
  ): Promise<QueryExecutionRecord> {
    const idUuid = input.id ? entityIdToPgUuid(input.id) : newDualId().uuid;
    const wsUuid = entityIdToPgUuid(input.workspaceId);
    const connUuid = entityIdToPgUuid(input.connectionId);
    const consoleUuid = optionalEntityIdToPgUuid(input.consoleId);
    const [userUuid, apiKeyUuid] = await Promise.all([
      this.resolveNullableUserUuid(input.userId, db),
      this.resolveExistingApiKeyUuid(input.apiKeyId, db),
    ]);

    const values: typeof queryExecutions.$inferInsert = {
      id: idUuid,
      executedAt: input.executedAt ?? new Date(),
      userId: userUuid,
      apiKeyId: apiKeyUuid,
      workspaceId: wsUuid,
      connectionId: connUuid,
      databaseName: input.databaseName ?? null,
      consoleId: consoleUuid,
      source: input.source,
      databaseType: input.databaseType,
      queryLanguage: input.queryLanguage,
      status: input.status,
      executionTimeMs: input.executionTimeMs,
      rowCount: input.rowCount ?? null,
      errorType: input.errorType ?? null,
      bytesScanned: input.bytesScanned ?? null,
    };

    const insertQuery = db.insert(queryExecutions).values(values);
    const rows = options.overwrite
      ? await insertQuery
          .onConflictDoUpdate({
            target: queryExecutions.id,
            set: {
              executedAt: values.executedAt,
              userId: values.userId,
              apiKeyId: values.apiKeyId,
              workspaceId: values.workspaceId,
              connectionId: values.connectionId,
              databaseName: values.databaseName,
              consoleId: values.consoleId,
              source: values.source,
              databaseType: values.databaseType,
              queryLanguage: values.queryLanguage,
              status: values.status,
              executionTimeMs: values.executionTimeMs,
              rowCount: values.rowCount,
              errorType: values.errorType,
              bytesScanned: values.bytesScanned,
            },
          })
          .returning()
      : await insertQuery
          .onConflictDoNothing({ target: queryExecutions.id })
          .returning();

    if (rows[0]) {
      return pgQueryExecutionToRecord(rows[0]);
    }
    const existing = await db
      .select()
      .from(queryExecutions)
      .where(eq(queryExecutions.id, idUuid))
      .limit(1);
    if (!existing[0]) {
      throw new Error(`Failed to insert query_executions row ${idUuid}`);
    }
    return pgQueryExecutionToRecord(existing[0]);
  }

  async listWorkspaceQueryExecutions(
    workspaceId: string,
    options: ListQueryExecutionsOptions = {},
    db: MakoPgDb = this.getDb(),
  ): Promise<{ executions: QueryExecutionRecord[]; total: number }> {
    const {
      limit = 100,
      offset = 0,
      startDate,
      endDate,
      userId,
      status,
    } = options;
    const wsUuid = entityIdToPgUuid(workspaceId);
    const conditions = [eq(queryExecutions.workspaceId, wsUuid)];
    if (startDate) conditions.push(gte(queryExecutions.executedAt, startDate));
    if (endDate) conditions.push(lte(queryExecutions.executedAt, endDate));
    if (status) conditions.push(eq(queryExecutions.status, status));
    if (userId) {
      if (userId.trim() === "system") {
        conditions.push(isNull(queryExecutions.userId));
      } else {
        const resolvedUser = await this.resolveNullableUserUuid(userId, db);
        if (!resolvedUser) return { executions: [], total: 0 };
        conditions.push(eq(queryExecutions.userId, resolvedUser));
      }
    }

    const where = and(...conditions);
    const [rows, countRows] = await Promise.all([
      db
        .select()
        .from(queryExecutions)
        .where(where)
        .orderBy(desc(queryExecutions.executedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(queryExecutions)
        .where(where),
    ]);
    return {
      executions: rows.map(pgQueryExecutionToRecord),
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  async listConsoleQueryExecutions(
    workspaceId: string,
    consoleId: string,
    limit = 10,
    db: MakoPgDb = this.getDb(),
  ): Promise<QueryExecutionRecord[]> {
    const clamped = Math.min(Math.max(limit, 1), 50);
    const wsUuid = entityIdToPgUuid(workspaceId);
    const consoleUuid = entityIdToPgUuid(consoleId);
    const rows = await db
      .select()
      .from(queryExecutions)
      .where(
        and(
          eq(queryExecutions.workspaceId, wsUuid),
          eq(queryExecutions.consoleId, consoleUuid),
        ),
      )
      .orderBy(desc(queryExecutions.executedAt))
      .limit(clamped);
    return rows.map(pgQueryExecutionToRecord);
  }

  async getWorkspaceQueryExecutionSummary(
    workspaceId: string,
    startDate: Date,
    endDate: Date,
    db: MakoPgDb = this.getDb(),
  ): Promise<WorkspaceQueryExecutionSummary> {
    const wsUuid = entityIdToPgUuid(workspaceId);
    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    const [summaryRes, bySourceRes, byDbTypeRes, byUserRes] = await Promise.all(
      [
        db.execute(sql`
        SELECT
          COUNT(*)::int AS "total_executions",
          COUNT(*) FILTER (WHERE "status" = 'success')::int AS "success_count",
          COUNT(*) FILTER (WHERE "status" = 'error')::int AS "error_count",
          COUNT(*) FILTER (WHERE "status" = 'cancelled')::int AS "cancelled_count",
          COUNT(*) FILTER (WHERE "status" = 'timeout')::int AS "timeout_count",
          COALESCE(SUM("execution_time_ms"), 0)::bigint AS "total_execution_time_ms"
        FROM "query_executions"
        WHERE "workspace_id" = ${wsUuid}::uuid
          AND "executed_at" >= ${startIso}::timestamptz
          AND "executed_at" <= ${endIso}::timestamptz
      `),
        db.execute(sql`
        SELECT "source" AS "key", COUNT(*)::int AS "count"
        FROM "query_executions"
        WHERE "workspace_id" = ${wsUuid}::uuid
          AND "executed_at" >= ${startIso}::timestamptz
          AND "executed_at" <= ${endIso}::timestamptz
        GROUP BY "source"
      `),
        db.execute(sql`
        SELECT "database_type" AS "key", COUNT(*)::int AS "count"
        FROM "query_executions"
        WHERE "workspace_id" = ${wsUuid}::uuid
          AND "executed_at" >= ${startIso}::timestamptz
          AND "executed_at" <= ${endIso}::timestamptz
        GROUP BY "database_type"
      `),
        db.execute(sql`
        SELECT COALESCE("user_id"::text, 'system') AS "key", COUNT(*)::int AS "count"
        FROM "query_executions"
        WHERE "workspace_id" = ${wsUuid}::uuid
          AND "executed_at" >= ${startIso}::timestamptz
          AND "executed_at" <= ${endIso}::timestamptz
        GROUP BY COALESCE("user_id"::text, 'system')
      `),
      ],
    );

    const summary = extractRows<{
      total_executions: number | string;
      success_count: number | string;
      error_count: number | string;
      cancelled_count: number | string;
      timeout_count: number | string;
      total_execution_time_ms: number | string;
    }>(summaryRes)[0];

    const toRecord = <T extends string>(result: unknown): Record<T, number> => {
      const out = {} as Record<T, number>;
      for (const r of extractRows<{ key: T | null; count: number | string }>(
        result,
      )) {
        if (r.key) out[r.key] = Number(r.count ?? 0);
      }
      return out;
    };

    const totalExecutions = Number(summary?.total_executions ?? 0);
    const totalExecutionTimeMs = Number(summary?.total_execution_time_ms ?? 0);

    return {
      totalExecutions,
      successCount: Number(summary?.success_count ?? 0),
      errorCount: Number(summary?.error_count ?? 0),
      cancelledCount: Number(summary?.cancelled_count ?? 0),
      timeoutCount: Number(summary?.timeout_count ?? 0),
      totalExecutionTimeMs,
      avgExecutionTimeMs: totalExecutions
        ? Math.round(totalExecutionTimeMs / totalExecutions)
        : 0,
      bySource: toRecord<QueryExecutionSourcePg>(bySourceRes),
      byDatabaseType: toRecord<string>(byDbTypeRes),
      byUser: toRecord<string>(byUserRes),
    };
  }

  // ── connection_verifications ─────────────────────────────────────────────

  async createConnectionVerification(
    input: CreateConnectionVerificationInput,
    db: MakoPgDb = this.getDb(),
    options: { overwrite?: boolean } = {},
  ): Promise<ConnectionVerificationRecord> {
    const idUuid = input.id ? entityIdToPgUuid(input.id) : newDualId().uuid;
    const wsUuid = optionalEntityIdToPgUuid(input.workspaceId);
    const [connUuid, userUuid] = await Promise.all([
      this.resolveExistingConnectionUuid(input.connectionId, db),
      this.resolveNullableUserUuid(input.userId, db),
    ]);

    const values: typeof connectionVerifications.$inferInsert = {
      id: idUuid,
      verifiedAt: input.verifiedAt ?? new Date(),
      userId: userUuid,
      workspaceId: wsUuid,
      connectionId: connUuid,
      databaseType: input.databaseType,
      trigger: input.trigger,
      success: input.success,
      durationMs: input.durationMs,
      errorClass: input.errorClass ?? null,
      errorMessage: input.errorMessage ?? null,
    };

    const insertQuery = db.insert(connectionVerifications).values(values);
    const rows = options.overwrite
      ? await insertQuery
          .onConflictDoUpdate({
            target: connectionVerifications.id,
            set: {
              verifiedAt: values.verifiedAt,
              userId: values.userId,
              workspaceId: values.workspaceId,
              connectionId: values.connectionId,
              databaseType: values.databaseType,
              trigger: values.trigger,
              success: values.success,
              durationMs: values.durationMs,
              errorClass: values.errorClass,
              errorMessage: values.errorMessage,
            },
          })
          .returning()
      : await insertQuery
          .onConflictDoNothing({ target: connectionVerifications.id })
          .returning();

    if (rows[0]) {
      return pgConnectionVerificationToRecord(rows[0]);
    }
    const existing = await db
      .select()
      .from(connectionVerifications)
      .where(eq(connectionVerifications.id, idUuid))
      .limit(1);
    if (!existing[0]) {
      throw new Error(
        `Failed to insert connection_verifications row ${idUuid}`,
      );
    }
    return pgConnectionVerificationToRecord(existing[0]);
  }

  /** Helper for verifier / rollover reconciliation: list PG daily rows for one UTC day. */
  async listAppUsageDailyByDay(
    day: string,
    workspaceId?: string | null,
    db: MakoPgDb = this.getDb(),
  ): Promise<AppUsageDailyRecord[]> {
    const conditions = [eq(appUsageDaily.day, day)];
    if (workspaceId) {
      conditions.push(
        eq(appUsageDaily.workspaceId, entityIdToPgUuid(workspaceId)),
      );
    }
    const rows = await db
      .select()
      .from(appUsageDaily)
      .where(and(...conditions));
    return rows.map(row => ({
      id: toWireId(row.id),
      workspaceId: toWireId(row.workspaceId),
      appId: toWireId(row.appId),
      userId: visitorKeyToWireUserId(row.visitorKey),
      day: row.day,
      opens: row.opens,
      activeSeconds: row.activeSeconds,
      sources: {
        ...(row.sourcesApp ? { app: row.sourcesApp } : {}),
        ...(row.sourcesShare ? { share: row.sourcesShare } : {}),
        ...(row.sourcesEmbed ? { embed: row.sourcesEmbed } : {}),
      },
      firstAt: row.firstAt,
      lastAt: row.lastAt,
    }));
  }

  /** Helper for verifier / rollover reconciliation: list PG skill rows for one UTC day. */
  async listSkillUsageDailyByDay(
    day: string,
    workspaceId?: string | null,
    db: MakoPgDb = this.getDb(),
  ): Promise<SkillUsageDailyRecord[]> {
    const conditions = [eq(skillUsageDaily.day, day)];
    if (workspaceId) {
      conditions.push(
        eq(skillUsageDaily.workspaceId, entityIdToPgUuid(workspaceId)),
      );
    }
    const rows = await db
      .select()
      .from(skillUsageDaily)
      .where(and(...conditions));
    return rows.map(row => ({
      id: toWireId(row.id),
      workspaceId: toWireId(row.workspaceId),
      scope: row.scope,
      skill: row.skill,
      source: row.source,
      day: row.day,
      loads: row.loads,
      resourceReads: row.resourceReads,
      relevantHits: row.relevantHits,
      firstAt: row.firstAt,
      lastAt: row.lastAt,
    }));
  }

  /** Helper for batch-checking existing rows by IDs (verifier). */
  async findByIds<T extends { id: string }>(
    table:
      | typeof appUsageDaily
      | typeof appUsageEvents
      | typeof skillUsageDaily
      | typeof llmUsage
      | typeof queryExecutions
      | typeof connectionVerifications,
    uuids: readonly string[],
    db: MakoPgDb = this.getDb(),
  ): Promise<T[]> {
    if (uuids.length === 0) return [];
    const rows = await db
      .select()
      .from(table)
      .where(inArray(table.id, [...uuids]));
    return rows as unknown as T[];
  }
}
