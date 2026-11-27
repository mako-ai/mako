import { Types } from "mongoose";
import { parseEntityId } from "../database/pg/id-codec";
import { type IQueryExecution } from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  usageStatsRepo,
  type QueryExecutionRecord,
} from "../repositories/usage-stats";

const logger = loggers.query();

function toCompatObjectId(id: string): Types.ObjectId | string {
  const parsed = parseEntityId(id);
  return parsed?.oid ? new Types.ObjectId(parsed.oid) : id;
}

function recordToQueryExecutionCompat(
  rec: QueryExecutionRecord,
): IQueryExecution {
  return {
    ...rec,
    _id: toCompatObjectId(rec.id),
    workspaceId: toCompatObjectId(rec.workspaceId),
    connectionId: toCompatObjectId(rec.connectionId),
    ...(rec.apiKeyId ? { apiKeyId: toCompatObjectId(rec.apiKeyId) } : {}),
    ...(rec.consoleId ? { consoleId: toCompatObjectId(rec.consoleId) } : {}),
  } as unknown as IQueryExecution;
}

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
  | "scheduled_query";

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
      const execution = await usageStatsRepo.createQueryExecution({
        executedAt: new Date(),
        userId: input.userId,
        apiKeyId: input.apiKeyId?.toString(),
        workspaceId: input.workspaceId.toString(),
        connectionId: input.connectionId.toString(),
        databaseName: input.databaseName,
        consoleId: input.consoleId?.toString(),
        source: input.source,
        databaseType: input.databaseType,
        queryLanguage: input.queryLanguage,
        status: input.status,
        executionTimeMs: input.executionTimeMs,
        rowCount: input.rowCount,
        errorType: input.errorType,
        bytesScanned: input.bytesScanned,
      });

      const compat = recordToQueryExecutionCompat(execution);

      logger.debug("Query execution tracked", {
        executionId: compat._id,
        workspaceId: input.workspaceId,
        source: input.source,
        status: input.status,
        executionTimeMs: input.executionTimeMs,
      });

      return compat;
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
    const { executions, total } =
      await usageStatsRepo.listWorkspaceQueryExecutions(
        workspaceId.toString(),
        options,
      );

    return {
      executions: executions.map(recordToQueryExecutionCompat),
      total,
    };
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

    const executions = await usageStatsRepo.listConsoleQueryExecutions(
      workspaceId.toString(),
      consoleId.toString(),
      limit,
    );

    return executions.map(recordToQueryExecutionCompat);
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
    return usageStatsRepo.getWorkspaceQueryExecutionSummary(
      workspaceId.toString(),
      startDate,
      endDate,
    );
  }
}

// Export singleton instance
export const queryExecutionService = new QueryExecutionService();
