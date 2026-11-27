/**
 * Store-agnostic DTOs and repository contract for the Phase 2B `usage_stats` domain.
 *
 * Covers the 7 usage, telemetry, feed-snapshot, and metered-billing tables:
 *   - `app_usage_daily`          (daily `$inc` rollup; immutable `visitor_key`, NO TTL)
 *   - `app_usage_events`         (raw append-only view log; 400d TTL)
 *   - `app_feed_snapshots`       (ephemeral 24h cursor; skip backfill; 24h PG->Mongo fallback in Stage 4)
 *   - `skill_usage_daily`        (daily `$inc` rollup; 400d TTL on `last_at`)
 *   - `llm_usage`                (permanent metered billing ledger; NO TTL)
 *   - `query_executions`         (90d TTL; `connection_id` soft UUID NOT NULL)
 *   - `connection_verifications` (90d TTL; deferred `connection_id` FK post-backfill)
 */
import type {
  AppUsageBackfillSource,
  AppUsageEventKind,
  AppUsageEventSource,
  AppUsagePlacementJson,
  AppUsageReferrerKindPg,
  AppUsageUaClassPg,
  ConnectionVerificationTriggerPg,
  LlmInvocationTypePg,
  LlmUsageStepJson,
  QueryExecutionLanguagePg,
  QueryExecutionSourcePg,
  QueryExecutionStatusPg,
  SkillUsageScopePg,
  SkillUsageSourcePg,
} from "../../database/pg/schema/usage-stats";

export type {
  AppUsageBackfillSource,
  AppUsageEventKind,
  AppUsageEventSource,
  AppUsagePlacementJson,
  AppUsageReferrerKindPg,
  AppUsageUaClassPg,
  ConnectionVerificationTriggerPg,
  LlmInvocationTypePg,
  LlmUsageStepJson,
  QueryExecutionLanguagePg,
  QueryExecutionSourcePg,
  QueryExecutionStatusPg,
  SkillUsageScopePg,
  SkillUsageSourcePg,
};

// ── app_usage_daily ──────────────────────────────────────────────────────────

export interface AppUsageDailyRecord {
  id: string;
  workspaceId: string;
  appId: string;
  /** Wire viewer id: user UUID/legacy id, `anon:<hash>`, `ph:<id>`, or null. */
  userId: string | null;
  /** UTC YYYY-MM-DD day bucket. */
  day: string;
  opens: number;
  activeSeconds: number;
  sources: { app?: number; share?: number; embed?: number };
  firstAt: Date;
  lastAt: Date;
}

export interface BumpAppUsageDailyInput {
  id?: string;
  workspaceId: string;
  appId: string;
  /** Signed-in user ID (or null for anonymous viewers). */
  userId: string | null;
  /** First-party anonymous id (`anon:<hash>` / `ph:<id>`) when `userId` is null. */
  anonId?: string | null;
  day: string;
  kind: AppUsageEventKind;
  source: AppUsageEventSource;
  /** Seconds to add when `kind === "heartbeat"` (default 60). */
  heartbeatSeconds?: number;
  at: Date;
}

export interface AppUsageDayRowRecord {
  appId: string;
  userId: string | null;
  day: string;
  opens: number;
  activeSeconds: number;
  lastAt: Date;
}

export interface AppUsageRollupRecord {
  appId: string;
  userId: string | null;
  days: string[];
  opens: number;
  activeSeconds: number;
  lastAt: Date;
}

export interface RecentlyViewedAppRecord {
  appId: string;
  lastOpenedAt: Date;
}

export interface HotWorkspaceUsageRecord {
  workspaceId: string;
  at: Date;
}

// ── app_usage_events ─────────────────────────────────────────────────────────

export interface AppUsageEventRecord {
  id: string;
  workspaceId: string;
  appId: string;
  at: Date;
  kind: AppUsageEventKind;
  source: AppUsageEventSource;
  userId: string | null;
  anonId: string | null;
  sessionId: string | null;
  referrerKind?: AppUsageReferrerKindPg | null;
  uaClass: AppUsageUaClassPg;
  throttled?: boolean;
  placement?: AppUsagePlacementJson;
  backfill?: AppUsageBackfillSource;
}

export interface CreateAppUsageEventInput {
  id?: string;
  workspaceId: string;
  appId: string;
  at: Date;
  kind: AppUsageEventKind;
  source: AppUsageEventSource;
  userId: string | null;
  anonId?: string | null;
  sessionId?: string | null;
  referrerKind?: AppUsageReferrerKindPg | null;
  uaClass: AppUsageUaClassPg;
  throttled?: boolean;
  placement?: AppUsagePlacementJson;
  backfill?: AppUsageBackfillSource;
}

// ── app_feed_snapshots ───────────────────────────────────────────────────────

export interface AppFeedSnapshotRecord {
  id: string;
  workspaceId: string;
  userId: string | null;
  popular: string[];
  fresh: string[];
  recommended: string[];
  createdAt: Date;
}

export interface CreateAppFeedSnapshotInput {
  id?: string;
  workspaceId: string;
  userId: string | null;
  popular: string[];
  fresh: string[];
  recommended: string[];
  createdAt?: Date;
}

// ── skill_usage_daily ────────────────────────────────────────────────────────

export type SkillUsageBumpKind = "load" | "resource" | "relevant";

export interface SkillUsageTargetInput {
  scope: SkillUsageScopePg;
  skill: string;
}

export interface SkillUsageDailyRecord {
  id: string;
  workspaceId: string;
  scope: SkillUsageScopePg;
  skill: string;
  source: SkillUsageSourcePg;
  day: string;
  loads: number;
  resourceReads: number;
  relevantHits: number;
  firstAt: Date;
  lastAt: Date;
}

export interface SkillUsageAggregateRow {
  scope: SkillUsageScopePg;
  skill: string;
  loads30d: number;
  lastLoadedAt: Date | null;
}

// ── llm_usage ────────────────────────────────────────────────────────────────

export interface LlmWorkflowRunRef {
  workflowId: string;
  runId: string;
  step?: string;
  backfilled?: boolean;
}

export interface LlmUsageRecord {
  id: string;
  /** Compatibility alias mirroring `id` for callers reading `_id`. */
  _id: string;
  workspaceId: string;
  userId: string | null;
  chatId?: string | null;
  invocationType: LlmInvocationTypePg;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  steps?: LlmUsageStepJson[];
  agentId?: string;
  tags?: string[];
  durationMs?: number;
  workflowRun?: LlmWorkflowRunRef;
  createdAt: Date;
}

export interface CreateLlmUsageInput {
  id?: string;
  workspaceId: string;
  userId: string | null;
  chatId?: string | null;
  invocationType: LlmInvocationTypePg;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  costUsd: number;
  steps?: LlmUsageStepJson[];
  agentId?: string;
  tags?: string[];
  durationMs?: number;
  workflowRun?: LlmWorkflowRunRef;
  createdAt?: Date;
}

export interface DateRangeFilter {
  from?: Date;
  to?: Date;
}

export interface LlmUsageTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  invocationCount: number;
}

export interface LlmUsageByUserRow extends LlmUsageTotals {
  userId: string | null;
}

export interface LlmUsageByModelRow extends LlmUsageTotals {
  modelId: string | null;
}

export interface WorkflowRunStepCostRow {
  runId: string;
  step: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  backfilled: boolean;
}

export interface WorkflowDailyCostRow {
  day: string;
  costUsd: number;
  runIds: string[];
}

export interface UnattributedWorkflowCall {
  id: string;
  endedAt: number;
  durationMs?: number;
  costUsd: number;
}

export interface WorkflowRunBackfillPatch {
  id: string;
  workflowId: string;
  runId: string;
  step: string;
}

// ── query_executions ─────────────────────────────────────────────────────────

export interface QueryExecutionRecord {
  id: string;
  _id: string;
  executedAt: Date;
  userId: string | null;
  apiKeyId?: string;
  workspaceId: string;
  connectionId: string;
  databaseName?: string;
  consoleId?: string;
  source: QueryExecutionSourcePg;
  databaseType: string;
  queryLanguage: QueryExecutionLanguagePg;
  status: QueryExecutionStatusPg;
  executionTimeMs: number;
  rowCount?: number;
  errorType?: string;
  bytesScanned?: number;
}

export interface CreateQueryExecutionInput {
  id?: string;
  executedAt?: Date;
  userId: string | null;
  apiKeyId?: string;
  workspaceId: string;
  connectionId: string;
  databaseName?: string;
  consoleId?: string;
  source: QueryExecutionSourcePg;
  databaseType: string;
  queryLanguage: QueryExecutionLanguagePg;
  status: QueryExecutionStatusPg;
  executionTimeMs: number;
  rowCount?: number;
  errorType?: string;
  bytesScanned?: number;
}

export interface ListQueryExecutionsOptions {
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
  userId?: string;
  status?: QueryExecutionStatusPg;
}

export interface WorkspaceQueryExecutionSummary {
  totalExecutions: number;
  successCount: number;
  errorCount: number;
  cancelledCount: number;
  timeoutCount: number;
  totalExecutionTimeMs: number;
  avgExecutionTimeMs: number;
  bySource: Record<QueryExecutionSourcePg, number>;
  byDatabaseType: Record<string, number>;
  byUser: Record<string, number>;
}

// ── connection_verifications ─────────────────────────────────────────────────

export interface ConnectionVerificationRecord {
  id: string;
  verifiedAt: Date;
  userId?: string;
  workspaceId?: string;
  connectionId?: string;
  databaseType: string;
  trigger: ConnectionVerificationTriggerPg;
  success: boolean;
  durationMs: number;
  errorClass?: string;
  errorMessage?: string;
}

export interface CreateConnectionVerificationInput {
  id?: string;
  verifiedAt?: Date;
  userId?: string;
  workspaceId?: string;
  connectionId?: string;
  databaseType: string;
  trigger: ConnectionVerificationTriggerPg;
  success: boolean;
  durationMs: number;
  errorClass?: string;
  errorMessage?: string;
}

// ── Repository Contract ──────────────────────────────────────────────────────

export interface UsageStatsRepository {
  // app_usage_events & app_usage_daily
  createAppUsageEvent(
    input: CreateAppUsageEventInput,
  ): Promise<AppUsageEventRecord>;
  bumpAppUsageDaily(input: BumpAppUsageDailyInput): Promise<void>;
  loadAppUsageRollups(
    workspaceId: string,
    sinceDay: string,
  ): Promise<AppUsageRollupRecord[]>;
  listAppUsageDaysSince(
    workspaceId: string,
    sinceDay: string,
  ): Promise<AppUsageDayRowRecord[]>;
  getRecentlyViewedApps(
    workspaceId: string,
    userId: string,
    since: Date,
    limit: number,
  ): Promise<RecentlyViewedAppRecord[]>;
  getHotWorkspaceUsageSince(since: Date): Promise<HotWorkspaceUsageRecord[]>;
  findEarliestAppUsageDay(workspaceId: string): Promise<string | null>;

  // app_feed_snapshots (ephemeral 24h cursor; skip backfill; 24h fallback in Stage 4)
  createFeedSnapshot(input: CreateAppFeedSnapshotInput): Promise<string>;
  findFeedSnapshotById(
    id: string,
    workspaceId?: string,
    now?: Date,
  ): Promise<AppFeedSnapshotRecord | null>;

  // skill_usage_daily
  bumpSkillUsageDaily(
    workspaceId: string,
    targets: readonly SkillUsageTargetInput[],
    kind: SkillUsageBumpKind,
    source: SkillUsageSourcePg,
    at?: Date,
  ): Promise<void>;
  getSkillUsageSummary(
    workspaceId: string,
    sinceDay: string,
  ): Promise<SkillUsageAggregateRow[]>;

  // llm_usage (permanent metered billing ledger)
  createLlmUsage(input: CreateLlmUsageInput): Promise<LlmUsageRecord>;
  getWorkspaceLlmUsageSummary(
    workspaceId: string,
    range?: DateRangeFilter,
  ): Promise<LlmUsageTotals>;
  getWorkspaceLlmUsageByUser(
    workspaceId: string,
    range?: DateRangeFilter,
  ): Promise<LlmUsageByUserRow[]>;
  getWorkspaceLlmUsageByModel(
    workspaceId: string,
    range?: DateRangeFilter,
  ): Promise<LlmUsageByModelRow[]>;
  listLlmUsageByChat(
    workspaceId: string,
    chatId: string,
  ): Promise<LlmUsageRecord[]>;
  readWorkflowRunCosts(
    workspaceId: string,
    runIds: readonly string[],
  ): Promise<WorkflowRunStepCostRow[]>;
  readWorkflowDailyCosts(
    workspaceId: string,
    workflowId: string,
    since: Date,
  ): Promise<WorkflowDailyCostRow[]>;
  listUnattributedWorkflowCalls(
    workspaceId: string,
    since: Date,
  ): Promise<UnattributedWorkflowCall[]>;
  attachWorkflowRunToCalls(
    workspaceId: string,
    patches: readonly WorkflowRunBackfillPatch[],
  ): Promise<number>;

  // query_executions
  createQueryExecution(
    input: CreateQueryExecutionInput,
  ): Promise<QueryExecutionRecord>;
  listWorkspaceQueryExecutions(
    workspaceId: string,
    options?: ListQueryExecutionsOptions,
  ): Promise<{ executions: QueryExecutionRecord[]; total: number }>;
  listConsoleQueryExecutions(
    workspaceId: string,
    consoleId: string,
    limit?: number,
  ): Promise<QueryExecutionRecord[]>;
  getWorkspaceQueryExecutionSummary(
    workspaceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<WorkspaceQueryExecutionSummary>;

  // connection_verifications
  createConnectionVerification(
    input: CreateConnectionVerificationInput,
  ): Promise<ConnectionVerificationRecord>;
}
