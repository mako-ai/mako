/**
 * Phase 2B `usage_stats` domain repository entry point.
 *
 * Exports the singleton `usageStatsRepo` (backed by `DualUsageStatsRepository`,
 * defaulting to `mongo_only` until `migration_domain_state` advances `usage_stats`)
 * plus test override hooks and concrete repository classes.
 */
import { DualUsageStatsRepository } from "./dual.repo";
import type { UsageStatsRepository } from "./types";

export * from "./types";
export * from "./mapper";
export { MongoUsageStatsRepository } from "./mongo.repo";
export { PgUsageStatsRepository } from "./pg.repo";
export {
  DualUsageStatsRepository,
  USAGE_STATS_DOMAIN,
  USAGE_STATS_SHADOW_OPTIONS,
  type DualUsageStatsRepositoryDeps,
} from "./dual.repo";

const defaultUsageStatsRepo: UsageStatsRepository =
  new DualUsageStatsRepository();
let activeUsageStatsRepo: UsageStatsRepository = defaultUsageStatsRepo;

export function getUsageStatsRepo(): UsageStatsRepository {
  return activeUsageStatsRepo;
}

export function setUsageStatsRepoForTests(repo: UsageStatsRepository): void {
  activeUsageStatsRepo = repo;
}

export function resetUsageStatsRepoForTests(): void {
  activeUsageStatsRepo = defaultUsageStatsRepo;
}

export const usageStatsRepo: UsageStatsRepository = {
  createAppUsageEvent: input => activeUsageStatsRepo.createAppUsageEvent(input),
  bumpAppUsageDaily: input => activeUsageStatsRepo.bumpAppUsageDaily(input),
  loadAppUsageRollups: (workspaceId, sinceDay) =>
    activeUsageStatsRepo.loadAppUsageRollups(workspaceId, sinceDay),
  listAppUsageDaysSince: (workspaceId, sinceDay) =>
    activeUsageStatsRepo.listAppUsageDaysSince(workspaceId, sinceDay),
  getRecentlyViewedApps: (workspaceId, userId, since, limit) =>
    activeUsageStatsRepo.getRecentlyViewedApps(
      workspaceId,
      userId,
      since,
      limit,
    ),
  getHotWorkspaceUsageSince: since =>
    activeUsageStatsRepo.getHotWorkspaceUsageSince(since),
  findEarliestAppUsageDay: workspaceId =>
    activeUsageStatsRepo.findEarliestAppUsageDay(workspaceId),

  createFeedSnapshot: input => activeUsageStatsRepo.createFeedSnapshot(input),
  findFeedSnapshotById: (id, workspaceId, now) =>
    activeUsageStatsRepo.findFeedSnapshotById(id, workspaceId, now),

  bumpSkillUsageDaily: (workspaceId, targets, kind, source, at) =>
    activeUsageStatsRepo.bumpSkillUsageDaily(
      workspaceId,
      targets,
      kind,
      source,
      at,
    ),
  getSkillUsageSummary: (workspaceId, sinceDay) =>
    activeUsageStatsRepo.getSkillUsageSummary(workspaceId, sinceDay),

  createLlmUsage: input => activeUsageStatsRepo.createLlmUsage(input),
  getWorkspaceLlmUsageSummary: (workspaceId, range) =>
    activeUsageStatsRepo.getWorkspaceLlmUsageSummary(workspaceId, range),
  getWorkspaceLlmUsageByUser: (workspaceId, range) =>
    activeUsageStatsRepo.getWorkspaceLlmUsageByUser(workspaceId, range),
  getWorkspaceLlmUsageByModel: (workspaceId, range) =>
    activeUsageStatsRepo.getWorkspaceLlmUsageByModel(workspaceId, range),
  listLlmUsageByChat: (workspaceId, chatId) =>
    activeUsageStatsRepo.listLlmUsageByChat(workspaceId, chatId),
  readWorkflowRunCosts: (workspaceId, runIds) =>
    activeUsageStatsRepo.readWorkflowRunCosts(workspaceId, runIds),
  readWorkflowDailyCosts: (workspaceId, workflowId, since) =>
    activeUsageStatsRepo.readWorkflowDailyCosts(workspaceId, workflowId, since),
  listUnattributedWorkflowCalls: (workspaceId, since) =>
    activeUsageStatsRepo.listUnattributedWorkflowCalls(workspaceId, since),
  attachWorkflowRunToCalls: (workspaceId, patches) =>
    activeUsageStatsRepo.attachWorkflowRunToCalls(workspaceId, patches),

  createQueryExecution: input =>
    activeUsageStatsRepo.createQueryExecution(input),
  listWorkspaceQueryExecutions: (workspaceId, options) =>
    activeUsageStatsRepo.listWorkspaceQueryExecutions(workspaceId, options),
  listConsoleQueryExecutions: (workspaceId, consoleId, limit) =>
    activeUsageStatsRepo.listConsoleQueryExecutions(
      workspaceId,
      consoleId,
      limit,
    ),
  getWorkspaceQueryExecutionSummary: (workspaceId, startDate, endDate) =>
    activeUsageStatsRepo.getWorkspaceQueryExecutionSummary(
      workspaceId,
      startDate,
      endDate,
    ),

  createConnectionVerification: input =>
    activeUsageStatsRepo.createConnectionVerification(input),
};
