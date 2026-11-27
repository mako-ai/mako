/**
 * MongoDB (Mongoose) implementation of `UsageStatsRepository`.
 *
 * Preserves exact existing Mongoose behavior, index usage, and duplicate-key
 * upsert race retries while conforming to the store-agnostic repository contract.
 */
import { Types } from "mongoose";
import { LlmUsage } from "../../database/schema";
import {
  AppFeedSnapshot,
  AppUsageDaily,
  AppUsageEvent,
  ConnectionVerification,
  QueryExecution,
  SkillUsageDaily,
} from "../../database/workspace-schema";
import {
  isObjectIdHex,
  isObjectIdUuid,
  uuidToObjectId,
} from "../../database/pg/id-codec";
import {
  mongoAppFeedSnapshotToRecord,
  mongoAppUsageEventToRecord,
  mongoConnectionVerificationToRecord,
  mongoLlmUsageToRecord,
  mongoQueryExecutionToRecord,
  type MongoAppFeedSnapshotLike,
  type MongoAppUsageEventLike,
  type MongoConnectionVerificationLike,
  type MongoLlmUsageLike,
  type MongoQueryExecutionLike,
} from "./mapper";
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
  QueryExecutionSourcePg,
  RecentlyViewedAppRecord,
  SkillUsageAggregateRow,
  SkillUsageBumpKind,
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

const SKILL_COUNTER_OF: Record<SkillUsageBumpKind, string> = {
  load: "loads",
  resource: "resourceReads",
  relevant: "relevantHits",
};

function toObjectId(id: string): Types.ObjectId {
  if (isObjectIdHex(id)) return new Types.ObjectId(id);
  if (isObjectIdUuid(id)) return new Types.ObjectId(uuidToObjectId(id));
  return new Types.ObjectId(id);
}

function duplicateKeyIndexes(error: unknown): number[] {
  const writeErrors = (error as { writeErrors?: unknown }).writeErrors;
  if (!Array.isArray(writeErrors) || writeErrors.length === 0) return [];
  const indexes: number[] = [];
  for (const entry of writeErrors as Array<{
    code?: number;
    index?: number;
    err?: { code?: number; index?: number };
  }>) {
    const code = entry.code ?? entry.err?.code;
    const index = entry.index ?? entry.err?.index;
    if (code !== 11000 || typeof index !== "number") return [];
    indexes.push(index);
  }
  return indexes;
}

function buildDateMatch(range?: DateRangeFilter): Record<string, unknown> {
  if (!range?.from && !range?.to) return {};
  const createdAt: Record<string, Date> = {};
  if (range.from) createdAt.$gte = range.from;
  if (range.to) createdAt.$lte = range.to;
  return { createdAt };
}

const EMPTY_LLM_TOTALS: LlmUsageTotals = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalReasoningTokens: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  invocationCount: 0,
};

export class MongoUsageStatsRepository implements UsageStatsRepository {
  // ── app_usage_events & app_usage_daily ───────────────────────────────────

  async createAppUsageEvent(
    input: CreateAppUsageEventInput,
  ): Promise<AppUsageEventRecord> {
    const anonId = input.userId ? null : (input.anonId ?? null);
    const created = await AppUsageEvent.create({
      ...(input.id ? { _id: toObjectId(input.id) } : {}),
      workspaceId: toObjectId(input.workspaceId),
      appId: input.appId,
      at: input.at,
      kind: input.kind,
      source: input.source,
      userId: input.userId,
      anonId,
      sessionId: input.sessionId ?? null,
      ...(input.referrerKind ? { referrerKind: input.referrerKind } : {}),
      uaClass: input.uaClass,
      ...(input.throttled !== undefined ? { throttled: input.throttled } : {}),
      ...(input.placement ? { placement: input.placement } : {}),
      ...(input.backfill ? { backfill: input.backfill } : {}),
    });
    return mongoAppUsageEventToRecord(
      created.toObject() as unknown as MongoAppUsageEventLike,
    );
  }

  async bumpAppUsageDaily(input: BumpAppUsageDailyInput): Promise<void> {
    const anonId = input.userId ? null : (input.anonId ?? null);
    const viewerKey = input.userId ?? anonId ?? null;
    const inc: Record<string, number> =
      input.kind === "open"
        ? { opens: 1, [`sources.${input.source}`]: 1 }
        : { activeSeconds: input.heartbeatSeconds ?? 60 };

    const filter = {
      workspaceId: toObjectId(input.workspaceId),
      appId: input.appId,
      userId: viewerKey,
      day: input.day,
    };
    const update: Record<string, unknown> = {
      $inc: inc,
      $min: { firstAt: input.at },
      $max: { lastAt: input.at },
      ...(input.id ? { $setOnInsert: { _id: toObjectId(input.id) } } : {}),
    };

    try {
      await AppUsageDaily.updateOne(filter, update, { upsert: true });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      // Retry without $setOnInsert if concurrent first insert won the race.
      await AppUsageDaily.updateOne(
        filter,
        {
          $inc: inc,
          $min: { firstAt: input.at },
          $max: { lastAt: input.at },
        },
        { upsert: true },
      );
    }
  }

  async loadAppUsageRollups(
    workspaceId: string,
    sinceDay: string,
  ): Promise<AppUsageRollupRecord[]> {
    return AppUsageDaily.aggregate<AppUsageRollupRecord>([
      {
        $match: {
          workspaceId: toObjectId(workspaceId),
          day: { $gte: sinceDay },
        },
      },
      {
        $group: {
          _id: { appId: "$appId", userId: "$userId" },
          days: { $addToSet: "$day" },
          opens: { $sum: "$opens" },
          activeSeconds: { $sum: "$activeSeconds" },
          lastAt: { $max: "$lastAt" },
        },
      },
      {
        $project: {
          _id: 0,
          appId: "$_id.appId",
          userId: "$_id.userId",
          days: 1,
          opens: 1,
          activeSeconds: 1,
          lastAt: 1,
        },
      },
    ]);
  }

  async listAppUsageDaysSince(
    workspaceId: string,
    sinceDay: string,
  ): Promise<AppUsageDayRowRecord[]> {
    const rows = await AppUsageDaily.find({
      workspaceId: toObjectId(workspaceId),
      day: { $gte: sinceDay },
    })
      .select({
        _id: 0,
        appId: 1,
        userId: 1,
        day: 1,
        opens: 1,
        activeSeconds: 1,
        lastAt: 1,
      })
      .lean<AppUsageDayRowRecord[]>();
    return rows.map(r => ({
      appId: r.appId,
      userId: r.userId ?? null,
      day: r.day,
      opens: r.opens ?? 0,
      activeSeconds: r.activeSeconds ?? 0,
      lastAt: r.lastAt instanceof Date ? r.lastAt : new Date(r.lastAt),
    }));
  }

  async getRecentlyViewedApps(
    workspaceId: string,
    userId: string,
    since: Date,
    limit: number,
  ): Promise<RecentlyViewedAppRecord[]> {
    const rows = await AppUsageDaily.aggregate<{ _id: string; lastAt: Date }>([
      {
        $match: {
          workspaceId: toObjectId(workspaceId),
          userId,
          lastAt: { $gte: since },
        },
      },
      { $group: { _id: "$appId", lastAt: { $max: "$lastAt" } } },
      { $sort: { lastAt: -1 } },
      { $limit: limit },
    ]);
    return rows.map(r => ({
      appId: r._id,
      lastOpenedAt: r.lastAt instanceof Date ? r.lastAt : new Date(r.lastAt),
    }));
  }

  async getHotWorkspaceUsageSince(
    since: Date,
  ): Promise<HotWorkspaceUsageRecord[]> {
    const rows = await AppUsageDaily.aggregate<{ _id: unknown; at: Date }>([
      { $match: { lastAt: { $gte: since } } },
      { $group: { _id: "$workspaceId", at: { $max: "$lastAt" } } },
    ]);
    return rows.map(r => ({
      workspaceId: String(r._id),
      at: r.at instanceof Date ? r.at : new Date(r.at),
    }));
  }

  async findEarliestAppUsageDay(workspaceId: string): Promise<string | null> {
    const doc = await AppUsageDaily.findOne({
      workspaceId: toObjectId(workspaceId),
    })
      .sort({ day: 1 })
      .select("day")
      .lean<{ day?: string } | null>();
    return doc?.day ?? null;
  }

  // ── app_feed_snapshots ───────────────────────────────────────────────────

  async createFeedSnapshot(input: CreateAppFeedSnapshotInput): Promise<string> {
    const doc = await AppFeedSnapshot.create({
      ...(input.id ? { _id: toObjectId(input.id) } : {}),
      workspaceId: toObjectId(input.workspaceId),
      userId: input.userId,
      popular: input.popular,
      fresh: input.fresh,
      recommended: input.recommended,
      createdAt: input.createdAt ?? new Date(),
    });
    return doc._id.toString();
  }

  async findFeedSnapshotById(
    id: string,
    _workspaceId?: string,
    _now?: Date,
  ): Promise<AppFeedSnapshotRecord | null> {
    if (!isObjectIdHex(id) && !isObjectIdUuid(id)) return null;
    const doc = await AppFeedSnapshot.findById(
      toObjectId(id),
    ).lean<MongoAppFeedSnapshotLike | null>();
    return doc ? mongoAppFeedSnapshotToRecord(doc) : null;
  }

  // ── skill_usage_daily ────────────────────────────────────────────────────

  async bumpSkillUsageDaily(
    workspaceId: string,
    targets: readonly SkillUsageTargetInput[],
    kind: SkillUsageBumpKind,
    source: SkillUsageSourcePg,
    at: Date = new Date(),
    ids?: readonly string[],
  ): Promise<void> {
    if (targets.length === 0) return;
    const workspace = toObjectId(workspaceId);
    const day = at.toISOString().slice(0, 10);
    const operations = targets.map((target, idx) => ({
      updateOne: {
        filter: {
          workspaceId: workspace,
          scope: target.scope,
          skill: target.skill,
          source,
          day,
        },
        update: {
          $inc: { [SKILL_COUNTER_OF[kind]]: 1 },
          $min: { firstAt: at },
          $max: { lastAt: at },
          ...(ids?.[idx]
            ? { $setOnInsert: { _id: toObjectId(ids[idx]) } }
            : {}),
        },
        upsert: true,
      },
    }));

    try {
      await SkillUsageDaily.bulkWrite(operations, { ordered: false });
    } catch (error) {
      const failed = duplicateKeyIndexes(error);
      if (failed.length === 0) throw error;
      await SkillUsageDaily.bulkWrite(
        failed.map(index => ({
          updateOne: {
            filter: operations[index].updateOne.filter,
            update: {
              $inc: { [SKILL_COUNTER_OF[kind]]: 1 },
              $min: { firstAt: at },
              $max: { lastAt: at },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
  }

  async getSkillUsageSummary(
    workspaceId: string,
    sinceDay: string,
  ): Promise<SkillUsageAggregateRow[]> {
    const rows = await SkillUsageDaily.aggregate<{
      _id: { scope: SkillUsageScopePg; skill: string };
      loads30d: number;
      lastLoadedAt: Date | null;
    }>([
      { $match: { workspaceId: toObjectId(workspaceId) } },
      {
        $group: {
          _id: { scope: "$scope", skill: "$skill" },
          loads30d: {
            $sum: {
              $cond: [
                { $gte: ["$day", sinceDay] },
                {
                  $add: [
                    { $ifNull: ["$loads", 0] },
                    { $ifNull: ["$resourceReads", 0] },
                    { $ifNull: ["$relevantHits", 0] },
                  ],
                },
                0,
              ],
            },
          },
          lastLoadedAt: { $max: "$lastAt" },
        },
      },
    ]);
    return rows.map(row => ({
      scope: row._id.scope,
      skill: row._id.skill,
      loads30d: row.loads30d,
      lastLoadedAt: row.lastLoadedAt
        ? row.lastLoadedAt instanceof Date
          ? row.lastLoadedAt
          : new Date(row.lastLoadedAt)
        : null,
    }));
  }

  // ── llm_usage ────────────────────────────────────────────────────────────

  async createLlmUsage(input: CreateLlmUsageInput): Promise<LlmUsageRecord> {
    const doc = await LlmUsage.create({
      ...(input.id ? { _id: toObjectId(input.id) } : {}),
      workspaceId: toObjectId(input.workspaceId),
      userId: input.userId ?? "system",
      chatId: input.chatId ? toObjectId(input.chatId) : undefined,
      invocationType: input.invocationType,
      modelId: input.modelId,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      reasoningTokens: input.reasoningTokens ?? 0,
      totalTokens: input.totalTokens,
      costUsd: input.costUsd,
      steps: input.steps,
      agentId: input.agentId,
      tags: input.tags,
      durationMs: input.durationMs,
      workflowRun: input.workflowRun,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    return mongoLlmUsageToRecord(
      doc.toObject() as unknown as MongoLlmUsageLike,
    );
  }

  async getWorkspaceLlmUsageSummary(
    workspaceId: string,
    range?: DateRangeFilter,
  ): Promise<LlmUsageTotals> {
    const [result] = await LlmUsage.aggregate<LlmUsageTotals>([
      {
        $match: {
          workspaceId: toObjectId(workspaceId),
          ...buildDateMatch(range),
        },
      },
      {
        $group: {
          _id: null,
          totalInputTokens: { $sum: "$inputTokens" },
          totalOutputTokens: { $sum: "$outputTokens" },
          totalCacheReadTokens: { $sum: "$cacheReadTokens" },
          totalCacheWriteTokens: { $sum: "$cacheWriteTokens" },
          totalReasoningTokens: { $sum: "$reasoningTokens" },
          totalTokens: { $sum: "$totalTokens" },
          totalCostUsd: { $sum: "$costUsd" },
          invocationCount: { $sum: 1 },
        },
      },
      { $project: { _id: 0 } },
    ]);
    return result ?? { ...EMPTY_LLM_TOTALS };
  }

  async getWorkspaceLlmUsageByUser(
    workspaceId: string,
    range?: DateRangeFilter,
  ): Promise<LlmUsageByUserRow[]> {
    return LlmUsage.aggregate<LlmUsageByUserRow>([
      {
        $match: {
          workspaceId: toObjectId(workspaceId),
          ...buildDateMatch(range),
        },
      },
      {
        $group: {
          _id: "$userId",
          totalInputTokens: { $sum: "$inputTokens" },
          totalOutputTokens: { $sum: "$outputTokens" },
          totalCacheReadTokens: { $sum: "$cacheReadTokens" },
          totalCacheWriteTokens: { $sum: "$cacheWriteTokens" },
          totalReasoningTokens: { $sum: "$reasoningTokens" },
          totalTokens: { $sum: "$totalTokens" },
          totalCostUsd: { $sum: "$costUsd" },
          invocationCount: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          totalInputTokens: 1,
          totalOutputTokens: 1,
          totalCacheReadTokens: 1,
          totalCacheWriteTokens: 1,
          totalReasoningTokens: 1,
          totalTokens: 1,
          totalCostUsd: 1,
          invocationCount: 1,
        },
      },
      { $sort: { totalCostUsd: -1 } },
    ]);
  }

  async getWorkspaceLlmUsageByModel(
    workspaceId: string,
    range?: DateRangeFilter,
  ): Promise<LlmUsageByModelRow[]> {
    return LlmUsage.aggregate<LlmUsageByModelRow>([
      {
        $match: {
          workspaceId: toObjectId(workspaceId),
          ...buildDateMatch(range),
        },
      },
      {
        $group: {
          _id: "$modelId",
          totalInputTokens: { $sum: "$inputTokens" },
          totalOutputTokens: { $sum: "$outputTokens" },
          totalCacheReadTokens: { $sum: "$cacheReadTokens" },
          totalCacheWriteTokens: { $sum: "$cacheWriteTokens" },
          totalReasoningTokens: { $sum: "$reasoningTokens" },
          totalTokens: { $sum: "$totalTokens" },
          totalCostUsd: { $sum: "$costUsd" },
          invocationCount: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          modelId: "$_id",
          totalInputTokens: 1,
          totalOutputTokens: 1,
          totalCacheReadTokens: 1,
          totalCacheWriteTokens: 1,
          totalReasoningTokens: 1,
          totalTokens: 1,
          totalCostUsd: 1,
          invocationCount: 1,
        },
      },
      { $sort: { totalCostUsd: -1 } },
    ]);
  }

  async listLlmUsageByChat(
    workspaceId: string,
    chatId: string,
  ): Promise<LlmUsageRecord[]> {
    const docs = await LlmUsage.find({
      workspaceId: toObjectId(workspaceId),
      chatId: toObjectId(chatId),
    })
      .sort({ createdAt: 1 })
      .lean<MongoLlmUsageLike[]>();
    return docs.map(mongoLlmUsageToRecord);
  }

  async readWorkflowRunCosts(
    workspaceId: string,
    runIds: readonly string[],
  ): Promise<WorkflowRunStepCostRow[]> {
    if (runIds.length === 0) return [];
    const rows = await LlmUsage.aggregate<{
      _id: { runId: string; step?: string };
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      calls: number;
      backfilled: boolean;
    }>([
      {
        $match: {
          workspaceId: toObjectId(workspaceId),
          "workflowRun.runId": { $in: [...runIds] },
        },
      },
      {
        $group: {
          _id: { runId: "$workflowRun.runId", step: "$workflowRun.step" },
          costUsd: { $sum: "$costUsd" },
          inputTokens: { $sum: "$inputTokens" },
          outputTokens: { $sum: "$outputTokens" },
          calls: { $sum: 1 },
          backfilled: {
            $max: { $ifNull: ["$workflowRun.backfilled", false] },
          },
        },
      },
    ]);
    return rows.map(r => ({
      runId: r._id.runId,
      step: r._id.step ?? null,
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      calls: r.calls,
      backfilled: Boolean(r.backfilled),
    }));
  }

  async readWorkflowDailyCosts(
    workspaceId: string,
    workflowId: string,
    since: Date,
  ): Promise<WorkflowDailyCostRow[]> {
    const rows = await LlmUsage.aggregate<{
      _id: string;
      costUsd: number;
      runs: string[];
    }>([
      {
        $match: {
          workspaceId: toObjectId(workspaceId),
          "workflowRun.workflowId": workflowId,
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          costUsd: { $sum: "$costUsd" },
          runs: { $addToSet: "$workflowRun.runId" },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    return rows.map(row => ({
      day: row._id,
      costUsd: row.costUsd,
      runIds: [...row.runs].filter(Boolean).sort(),
    }));
  }

  async listUnattributedWorkflowCalls(
    workspaceId: string,
    since: Date,
  ): Promise<UnattributedWorkflowCall[]> {
    const rows = await LlmUsage.find({
      workspaceId: toObjectId(workspaceId),
      invocationType: "workflow",
      workflowRun: { $exists: false },
      createdAt: { $gte: since },
    })
      .select("_id createdAt durationMs costUsd")
      .lean<
        Array<{
          _id: Types.ObjectId;
          createdAt: Date;
          durationMs?: number;
          costUsd?: number;
        }>
      >();
    return rows.map(row => ({
      id: String(row._id),
      endedAt: new Date(row.createdAt).getTime(),
      durationMs: row.durationMs,
      costUsd: row.costUsd ?? 0,
    }));
  }

  async attachWorkflowRunToCalls(
    workspaceId: string,
    patches: readonly WorkflowRunBackfillPatch[],
  ): Promise<number> {
    if (patches.length === 0) return 0;
    const ws = toObjectId(workspaceId);
    const result = await LlmUsage.bulkWrite(
      patches.map(p => ({
        updateOne: {
          filter: {
            _id: toObjectId(p.id),
            workspaceId: ws,
            workflowRun: { $exists: false },
          },
          update: {
            $set: {
              workflowRun: {
                workflowId: p.workflowId,
                runId: p.runId,
                step: p.step,
                backfilled: true,
              },
            },
          },
        },
      })),
    );
    return result.modifiedCount;
  }

  // ── query_executions ─────────────────────────────────────────────────────

  async createQueryExecution(
    input: CreateQueryExecutionInput,
  ): Promise<QueryExecutionRecord> {
    const doc = await QueryExecution.create({
      ...(input.id ? { _id: toObjectId(input.id) } : {}),
      executedAt: input.executedAt ?? new Date(),
      userId: input.userId ?? "system",
      apiKeyId: input.apiKeyId ? toObjectId(input.apiKeyId) : undefined,
      workspaceId: toObjectId(input.workspaceId),
      connectionId: toObjectId(input.connectionId),
      databaseName: input.databaseName,
      consoleId: input.consoleId ? toObjectId(input.consoleId) : undefined,
      source: input.source,
      databaseType: input.databaseType,
      queryLanguage: input.queryLanguage,
      status: input.status,
      executionTimeMs: input.executionTimeMs,
      rowCount: input.rowCount,
      errorType: input.errorType,
      bytesScanned: input.bytesScanned,
    });
    return mongoQueryExecutionToRecord(
      doc.toObject() as unknown as MongoQueryExecutionLike,
    );
  }

  async listWorkspaceQueryExecutions(
    workspaceId: string,
    options: ListQueryExecutionsOptions = {},
  ): Promise<{ executions: QueryExecutionRecord[]; total: number }> {
    const {
      limit = 100,
      offset = 0,
      startDate,
      endDate,
      userId,
      status,
    } = options;
    const query: Record<string, unknown> = {
      workspaceId: toObjectId(workspaceId),
    };
    if (startDate || endDate) {
      const executedAt: Record<string, Date> = {};
      if (startDate) executedAt.$gte = startDate;
      if (endDate) executedAt.$lte = endDate;
      query.executedAt = executedAt;
    }
    if (userId) query.userId = userId;
    if (status) query.status = status;

    const [docs, total] = await Promise.all([
      QueryExecution.find(query)
        .sort({ executedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean<MongoQueryExecutionLike[]>(),
      QueryExecution.countDocuments(query),
    ]);
    return {
      executions: docs.map(mongoQueryExecutionToRecord),
      total,
    };
  }

  async listConsoleQueryExecutions(
    workspaceId: string,
    consoleId: string,
    limit = 10,
  ): Promise<QueryExecutionRecord[]> {
    const clamped = Math.min(Math.max(limit, 1), 50);
    const docs = await QueryExecution.find({
      workspaceId: toObjectId(workspaceId),
      consoleId: toObjectId(consoleId),
    })
      .sort({ executedAt: -1 })
      .limit(clamped)
      .lean<MongoQueryExecutionLike[]>();
    return docs.map(mongoQueryExecutionToRecord);
  }

  async getWorkspaceQueryExecutionSummary(
    workspaceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<WorkspaceQueryExecutionSummary> {
    const match = {
      workspaceId: toObjectId(workspaceId),
      executedAt: { $gte: startDate, $lte: endDate },
    };

    const [[summary], bySourceResult, byDatabaseTypeResult, byUserResult] =
      await Promise.all([
        QueryExecution.aggregate<{
          totalExecutions: number;
          successCount: number;
          errorCount: number;
          cancelledCount: number;
          timeoutCount: number;
          totalExecutionTimeMs: number;
        }>([
          { $match: match },
          {
            $group: {
              _id: null,
              totalExecutions: { $sum: 1 },
              successCount: {
                $sum: { $cond: [{ $eq: ["$status", "success"] }, 1, 0] },
              },
              errorCount: {
                $sum: { $cond: [{ $eq: ["$status", "error"] }, 1, 0] },
              },
              cancelledCount: {
                $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
              },
              timeoutCount: {
                $sum: { $cond: [{ $eq: ["$status", "timeout"] }, 1, 0] },
              },
              totalExecutionTimeMs: { $sum: "$executionTimeMs" },
            },
          },
        ]),
        QueryExecution.aggregate<{
          _id: QueryExecutionSourcePg;
          count: number;
        }>([
          { $match: match },
          { $group: { _id: "$source", count: { $sum: 1 } } },
        ]),
        QueryExecution.aggregate<{ _id: string; count: number }>([
          { $match: match },
          { $group: { _id: "$databaseType", count: { $sum: 1 } } },
        ]),
        QueryExecution.aggregate<{ _id: string; count: number }>([
          { $match: match },
          { $group: { _id: "$userId", count: { $sum: 1 } } },
        ]),
      ]);

    const toRecord = <T extends string>(
      arr: Array<{ _id: T; count: number }>,
    ): Record<T, number> =>
      arr.reduce(
        (acc, item) => {
          if (item._id) acc[item._id] = item.count;
          return acc;
        },
        {} as Record<T, number>,
      );

    return {
      totalExecutions: summary?.totalExecutions || 0,
      successCount: summary?.successCount || 0,
      errorCount: summary?.errorCount || 0,
      cancelledCount: summary?.cancelledCount || 0,
      timeoutCount: summary?.timeoutCount || 0,
      totalExecutionTimeMs: summary?.totalExecutionTimeMs || 0,
      avgExecutionTimeMs: summary?.totalExecutions
        ? Math.round(summary.totalExecutionTimeMs / summary.totalExecutions)
        : 0,
      bySource: toRecord(bySourceResult),
      byDatabaseType: toRecord(byDatabaseTypeResult),
      byUser: toRecord(byUserResult),
    };
  }

  // ── connection_verifications ─────────────────────────────────────────────

  async createConnectionVerification(
    input: CreateConnectionVerificationInput,
  ): Promise<ConnectionVerificationRecord> {
    const doc = await ConnectionVerification.create({
      ...(input.id ? { _id: toObjectId(input.id) } : {}),
      verifiedAt: input.verifiedAt ?? new Date(),
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.workspaceId
        ? { workspaceId: toObjectId(input.workspaceId) }
        : {}),
      ...(input.connectionId
        ? { connectionId: toObjectId(input.connectionId) }
        : {}),
      databaseType: input.databaseType,
      trigger: input.trigger,
      success: input.success,
      durationMs: input.durationMs,
      ...(input.errorClass ? { errorClass: input.errorClass } : {}),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    });
    return mongoConnectionVerificationToRecord(
      doc.toObject() as unknown as MongoConnectionVerificationLike,
    );
  }
}
