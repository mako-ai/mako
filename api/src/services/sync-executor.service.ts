import {
  performSync as performSyncOrchestrated,
  performSyncChunk as performSyncChunkOrchestrated,
  performBulkFlush as performBulkFlushOrchestrated,
  performPrepareStaging as performPrepareStagingOrchestrated,
  getTempCollectionCount as getTempCollectionCountOrchestrated,
  performStagingMerge as performStagingMergeOrchestrated,
  performStagingCleanup as performStagingCleanupOrchestrated,
  SyncChunkOptions,
  SyncChunkResult,
} from "../sync/sync-orchestrator";

// Logger interface for sync execution
export interface SyncLogger {
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    metadata?: any,
  ): void;
}

// Re-export types for convenience
export type { SyncChunkOptions, SyncChunkResult };

/**
 * Execute a single chunk of sync work
 */
export async function performSyncChunk(
  options: SyncChunkOptions,
): Promise<SyncChunkResult> {
  return performSyncChunkOrchestrated(options);
}

export async function performBulkFlush(
  options: SyncChunkOptions,
): Promise<{ flushed: number }> {
  return performBulkFlushOrchestrated(options);
}

export async function performPrepareStaging(
  options: SyncChunkOptions,
): Promise<void> {
  return performPrepareStagingOrchestrated(options);
}

export function getTempCollectionCount(
  flowId: string,
  entity: string,
): Promise<number> {
  return getTempCollectionCountOrchestrated(flowId, entity);
}

export async function performStagingMerge(
  options: SyncChunkOptions,
): Promise<{ written: number }> {
  return performStagingMergeOrchestrated(options);
}

export async function performStagingCleanup(
  options: SyncChunkOptions,
): Promise<void> {
  return performStagingCleanupOrchestrated(options);
}

/**
 * Execute sync using the refactored sync orchestrator
 */
export async function performSync(
  dataSourceId: string,
  destinationDatabaseId: string,
  destinationDatabaseName: string | undefined,
  entityFilter?: string[],
  isIncremental: boolean = false,
  logger?: SyncLogger,
  step?: any, // Inngest step object for serverless-friendly retries
  queries?: any[], // GraphQL/PostHog queries from the transfer
): Promise<void> {
  // Log sync context
  logger?.log("info", `Sync mode: ${isIncremental ? "incremental" : "full"}`);
  if (entityFilter && entityFilter.length > 0) {
    logger?.log("info", `Entity filter: ${entityFilter.join(", ")}`);
  }
  logger?.log("info", `Data source: ${dataSourceId}`);
  logger?.log("info", `Destination: ${destinationDatabaseId}`);
  if (destinationDatabaseName) {
    logger?.log(
      "info",
      `Destination Database Name: ${destinationDatabaseName}`,
    );
  }

  try {
    await performSyncOrchestrated(
      dataSourceId,
      destinationDatabaseId,
      destinationDatabaseName,
      entityFilter,
      isIncremental,
      logger,
      step, // Pass through the step parameter
      queries, // Pass through transfer queries for GraphQL/PostHog
    );
    logger?.log("info", "Sync process completed successfully");
  } catch (error) {
    const errorMsg = `Sync process failed: ${error instanceof Error ? error.message : String(error)}`;
    logger?.log("error", errorMsg);
    const wrappedError = new Error(errorMsg);
    (wrappedError as Error & { cause?: unknown }).cause = error;
    throw wrappedError;
  }
}
