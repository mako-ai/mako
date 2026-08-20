import { Types } from "mongoose";
import { QueryExecution, IQueryExecution } from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.query();

/**
 * Query execution source types
 */
export type QuerySource =
  | "console_ui"
  | "console_ui_admin_override"
  | "api"
  | "mcp"
  | "agent"
  | "flow"
  | "scheduled_query"
  | "app_runtime"
  | "app_public"
  | "materialization";

/**
 * Query execution status types
 */
export type QueryStatus = "success" | "error" | "cancelled" | "timeout";

/**
 * Query language types
 */
export type QueryLanguage = "sql" | "mongodb" | "javascript";

/**
 * Input for tracking a query execution
 */
export interface TrackQueryExecutionInput {
  // Who executed
  userId: string;
  apiKeyId?: Types.ObjectId | string;

  // What was executed against
  workspaceId: Types.ObjectId | string;
  connectionId: Types.ObjectId | string;
  databaseName?: string;

  // Optional console tracking
  consoleId?: Types.ObjectId | string;

  // Optional app attribution (per-app cost)
  appId?: Types.ObjectId | string;
  bindingId?: string;

  // Execution context
  source: QuerySource;
  databaseType: string;
  queryLanguage: QueryLanguage;

  // Results
  status: QueryStatus;
  executionTimeMs: number;
  rowCount?: number;
  errorType?: string;

  // Optional resource tracking
  bytesScanned?: number;
  cacheHit?: boolean;
}

export interface AppUsageWindow {
  byEngine: Array<{
    databaseType: string;
    runs: number;
    bytesScanned: number;
    executionTimeMs: number;
    errors: number;
  }>;
}

export interface AppUsageSummary {
  last24h: AppUsageWindow;
  last7d: AppUsageWindow;
  last90d: AppUsageWindow;
}

/**
 * Service for tracking query executions
 * Used for usage analytics, billing, and monitoring
 */
export class QueryExecutionService {
  /**
   * Track a query execution (fire-and-forget)
   * This method does not throw errors to avoid disrupting query responses
   */
  track(input: TrackQueryExecutionInput): void {
    // Fire-and-forget - don't await
    this.trackAsync(input).catch(error => {
      logger.error("Failed to track query execution", { error, input });
    });
  }

  /**
   * Track a query execution (async version)
   * Returns the created execution record
   */
  async trackAsync(
    input: TrackQueryExecutionInput,
  ): Promise<IQueryExecution | null> {
    try {
      const execution = new QueryExecution({
        executedAt: new Date(),
        userId: input.userId,
        apiKeyId: input.apiKeyId
          ? new Types.ObjectId(input.apiKeyId.toString())
          : undefined,
        workspaceId: new Types.ObjectId(input.workspaceId.toString()),
        connectionId: new Types.ObjectId(input.connectionId.toString()),
        databaseName: input.databaseName,
        consoleId: input.consoleId
          ? new Types.ObjectId(input.consoleId.toString())
          : undefined,
        appId: input.appId
          ? new Types.ObjectId(input.appId.toString())
          : undefined,
        bindingId: input.bindingId,
        source: input.source,
        databaseType: input.databaseType,
        queryLanguage: input.queryLanguage,
        status: input.status,
        executionTimeMs: input.executionTimeMs,
        rowCount: input.rowCount,
        errorType: input.errorType,
        bytesScanned: input.bytesScanned,
        cacheHit: input.cacheHit,
      });

      await execution.save();

      logger.debug("Query execution tracked", {
        executionId: execution._id,
        workspaceId: input.workspaceId,
        source: input.source,
        status: input.status,
        executionTimeMs: input.executionTimeMs,
      });

      return execution;
    } catch (error) {
      logger.error("Failed to save query execution", { error, input });
      return null;
    }
  }

  /**
   * Get query executions for a workspace with pagination
   */
  async getWorkspaceExecutions(
    workspaceId: Types.ObjectId | string,
    options: {
      limit?: number;
      offset?: number;
      startDate?: Date;
      endDate?: Date;
      userId?: string;
      status?: QueryStatus;
    } = {},
  ): Promise<{ executions: IQueryExecution[]; total: number }> {
    const {
      limit = 100,
      offset = 0,
      startDate,
      endDate,
      userId,
      status,
    } = options;

    const query: any = {
      workspaceId: new Types.ObjectId(workspaceId.toString()),
    };

    if (startDate || endDate) {
      query.executedAt = {};
      if (startDate) query.executedAt.$gte = startDate;
      if (endDate) query.executedAt.$lte = endDate;
    }

    if (userId) {
      query.userId = userId;
    }

    if (status) {
      query.status = status;
    }

    const [executions, total] = await Promise.all([
      QueryExecution.find(query)
        .sort({ executedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      QueryExecution.countDocuments(query),
    ]);

    return { executions: executions as IQueryExecution[], total };
  }

  /**
   * Get usage summary for a workspace
   */

  /**
   * Recent executions for a single saved console (newest first).
   * Relies on the 90-day TTL on query_executions.
   */
  async getConsoleExecutions(
    workspaceId: Types.ObjectId | string,
    consoleId: Types.ObjectId | string,
    options: { limit?: number } = {},
  ): Promise<IQueryExecution[]> {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);

    const executions = await QueryExecution.find({
      workspaceId: new Types.ObjectId(workspaceId.toString()),
      consoleId: new Types.ObjectId(consoleId.toString()),
    })
      .sort({ executedAt: -1 })
      .limit(limit)
      .select(
        "executedAt source status executionTimeMs rowCount errorType userId apiKeyId databaseType queryLanguage",
      )
      .lean();

    return executions as IQueryExecution[];
  }

  /**
   * Per-app warehouse usage over the standard guilt-meter windows.
   * "Total" is bounded by the collection's 90-day TTL — label it as such.
   * Costs are computed by the caller (pricing is engine-specific).
   */
  async getAppUsageSummary(
    workspaceId: Types.ObjectId | string,
    appId: Types.ObjectId | string,
  ): Promise<AppUsageSummary> {
    const now = Date.now();
    const match = {
      workspaceId: new Types.ObjectId(workspaceId.toString()),
      appId: new Types.ObjectId(appId.toString()),
    };

    const windowPipeline = (since: Date | null) => [
      ...(since ? [{ $match: { executedAt: { $gte: since } } }] : []),
      {
        $group: {
          _id: "$databaseType",
          runs: { $sum: 1 },
          bytesScanned: { $sum: { $ifNull: ["$bytesScanned", 0] } },
          executionTimeMs: { $sum: { $ifNull: ["$executionTimeMs", 0] } },
          errors: {
            $sum: { $cond: [{ $eq: ["$status", "error"] }, 1, 0] },
          },
        },
      },
    ];

    const [facets] = await QueryExecution.aggregate([
      { $match: match },
      {
        $facet: {
          last24h: windowPipeline(new Date(now - 24 * 3600 * 1000)),
          last7d: windowPipeline(new Date(now - 7 * 24 * 3600 * 1000)),
          last90d: windowPipeline(null),
        },
      },
    ]);

    const toWindow = (
      rows: Array<{
        _id: string;
        runs: number;
        bytesScanned: number;
        executionTimeMs: number;
        errors: number;
      }>,
    ): AppUsageWindow => ({
      byEngine: rows.map(r => ({
        databaseType: r._id,
        runs: r.runs,
        bytesScanned: r.bytesScanned,
        executionTimeMs: r.executionTimeMs,
        errors: r.errors,
      })),
    });

    return {
      last24h: toWindow(facets?.last24h ?? []),
      last7d: toWindow(facets?.last7d ?? []),
      last90d: toWindow(facets?.last90d ?? []),
    };
  }

  async getWorkspaceUsageSummary(
    workspaceId: Types.ObjectId | string,
    startDate: Date,
    endDate: Date,
  ): Promise<{
    totalExecutions: number;
    successCount: number;
    errorCount: number;
    cancelledCount: number;
    timeoutCount: number;
    totalExecutionTimeMs: number;
    avgExecutionTimeMs: number;
    bySource: Record<QuerySource, number>;
    byDatabaseType: Record<string, number>;
    byUser: Record<string, number>;
  }> {
    const match = {
      workspaceId: new Types.ObjectId(workspaceId.toString()),
      executedAt: { $gte: startDate, $lte: endDate },
    };

    const [summary] = await QueryExecution.aggregate([
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
    ]);

    const bySourceResult = await QueryExecution.aggregate([
      { $match: match },
      { $group: { _id: "$source", count: { $sum: 1 } } },
    ]);

    const byDatabaseTypeResult = await QueryExecution.aggregate([
      { $match: match },
      { $group: { _id: "$databaseType", count: { $sum: 1 } } },
    ]);

    const byUserResult = await QueryExecution.aggregate([
      { $match: match },
      { $group: { _id: "$userId", count: { $sum: 1 } } },
    ]);

    const toRecord = <T extends string>(
      arr: Array<{ _id: T; count: number }>,
    ): Record<T, number> => {
      return arr.reduce(
        (acc, item) => {
          if (item._id) acc[item._id] = item.count;
          return acc;
        },
        {} as Record<T, number>,
      );
    };

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
}

// Export singleton instance
export const queryExecutionService = new QueryExecutionService();
