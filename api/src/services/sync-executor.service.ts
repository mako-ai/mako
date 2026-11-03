import {
  performSyncChunk as performSyncChunkOrchestrated,
  performBulkFlush as performBulkFlushOrchestrated,
  performPrepareStaging as performPrepareStagingOrchestrated,
  performOverwriteTruncate as performOverwriteTruncateOrchestrated,
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
  onBatchFlushed?: () => Promise<void>,
): Promise<{ flushed: number }> {
  return performBulkFlushOrchestrated(options, onBatchFlushed);
}

export async function performPrepareStaging(
  options: SyncChunkOptions,
): Promise<void> {
  return performPrepareStagingOrchestrated(options);
}

export async function performOverwriteTruncate(
  options: SyncChunkOptions,
): Promise<void> {
  return performOverwriteTruncateOrchestrated(options);
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
