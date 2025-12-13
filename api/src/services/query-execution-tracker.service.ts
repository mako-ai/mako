import { Types } from "mongoose";

/**
 * Represents a tracked query execution
 */
interface TrackedExecution {
  executionId: string;
  workspaceId: string;
  connectionId: string;
  databaseType: string;
  startTime: Date;
  abortController: AbortController;
  // BigQuery-specific metadata
  bigQueryJobId?: string;
  bigQueryProjectId?: string;
  bigQueryLocation?: string;
}

/**
 * Service to track and manage running query executions
 * Allows for cancellation/interruption of queries
 */
class QueryExecutionTrackerService {
  private executions = new Map<string, TrackedExecution>();

  /**
   * Start tracking a new query execution
   */
  startTracking(
    workspaceId: string,
    connectionId: string,
    databaseType: string,
  ): { executionId: string; abortController: AbortController } {
    const executionId = new Types.ObjectId().toString();
    const abortController = new AbortController();

    this.executions.set(executionId, {
      executionId,
      workspaceId,
      connectionId,
      databaseType,
      startTime: new Date(),
      abortController,
    });

    console.log(
      `[QueryTracker] Started tracking execution ${executionId} for workspace ${workspaceId}`,
    );

    return { executionId, abortController };
  }

  /**
   * Update BigQuery-specific metadata for a tracked execution
   */
  updateBigQueryMetadata(
    executionId: string,
    jobId: string,
    projectId: string,
    location?: string,
  ): void {
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.bigQueryJobId = jobId;
      execution.bigQueryProjectId = projectId;
      execution.bigQueryLocation = location;
      console.log(
        `[QueryTracker] Updated BigQuery metadata for ${executionId}: job=${jobId}, project=${projectId}, location=${location}`,
      );
    }
  }

  /**
   * Stop tracking a query execution (called when query completes or fails)
   */
  stopTracking(executionId: string): void {
    const execution = this.executions.get(executionId);
    if (execution) {
      const duration = Date.now() - execution.startTime.getTime();
      console.log(
        `[QueryTracker] Stopped tracking execution ${executionId} after ${duration}ms`,
      );
      this.executions.delete(executionId);
    }
  }

  /**
   * Cancel a running query execution
   */
  async cancelExecution(
    executionId: string,
    workspaceId: string,
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    const execution = this.executions.get(executionId);

    if (!execution) {
      return {
        success: false,
        error: "Execution not found or already completed",
      };
    }

    // Verify workspace access
    if (execution.workspaceId !== workspaceId) {
      return {
        success: false,
        error: "Access denied to this execution",
      };
    }

    console.log(
      `[QueryTracker] Cancelling execution ${executionId} (type: ${execution.databaseType})`,
    );

    try {
      // Abort the HTTP request/query execution
      execution.abortController.abort();

      // Handle database-specific cancellation
      if (
        execution.databaseType === "bigquery" &&
        execution.bigQueryJobId &&
        execution.bigQueryProjectId
      ) {
        // BigQuery job cancellation will be handled by the database service
        // We just need to signal that it should be cancelled
        console.log(
          `[QueryTracker] BigQuery job cancellation requested: ${execution.bigQueryJobId}`,
        );
      }

      this.stopTracking(executionId);

      return {
        success: true,
        message: `Query execution cancelled successfully`,
      };
    } catch (error) {
      console.error(`[QueryTracker] Error cancelling execution:`, error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to cancel execution",
      };
    }
  }

  /**
   * Get information about a tracked execution
   */
  getExecution(executionId: string): TrackedExecution | undefined {
    return this.executions.get(executionId);
  }

  /**
   * Get all executions for a workspace
   */
  getWorkspaceExecutions(workspaceId: string): TrackedExecution[] {
    return Array.from(this.executions.values()).filter(
      exec => exec.workspaceId === workspaceId,
    );
  }

  /**
   * Clean up stale executions (older than 1 hour)
   */
  cleanupStaleExecutions(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    let cleaned = 0;

    for (const [executionId, execution] of this.executions.entries()) {
      if (execution.startTime.getTime() < oneHourAgo) {
        console.log(
          `[QueryTracker] Cleaning up stale execution ${executionId}`,
        );
        this.executions.delete(executionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[QueryTracker] Cleaned up ${cleaned} stale executions`);
    }
  }
}

// Singleton instance
export const queryExecutionTracker = new QueryExecutionTrackerService();

// Run cleanup every 10 minutes
setInterval(
  () => {
    queryExecutionTracker.cleanupStaleExecutions();
  },
  10 * 60 * 1000,
);
