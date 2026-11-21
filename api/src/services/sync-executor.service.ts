import {
  performSyncChunk as performSyncChunkOrchestrated,
  performBulkFlush as performBulkFlushOrchestrated,
  performPrepareStaging as performPrepareStagingOrchestrated,
  performRescueAndPrepareStaging as performRescueAndPrepareStagingOrchestrated,
  getTempCollectionCount as getTempCollectionCountOrchestrated,
  discardBulkBuffer as discardBulkBufferOrchestrated,
  performStagingMerge as performStagingMergeOrchestrated,
  performStagingCleanup as performStagingCleanupOrchestrated,
  SyncChunkOptions,
  SyncChunkResult,
} from "../sync/sync-orchestrator";
export { performOverwriteTruncate } from "../sync/sync-orchestrator";
import type { CdcMergePath } from "../sync-cdc/table-write-lease";

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

export async function performRescueAndPrepareStaging(
  options: SyncChunkOptions,
  opts?: { dedupOnly?: boolean },
): Promise<{ rescued: number }> {
  return performRescueAndPrepareStagingOrchestrated(options, opts);
}

export function getTempCollectionCount(
  flowId: string,
  entity: string,
  fullRead?: boolean,
): Promise<number> {
  return getTempCollectionCountOrchestrated(flowId, entity, fullRead);
}

export function discardBulkBuffer(
  flowId: string,
  entity: string,
  fullRead?: boolean,
): Promise<number> {
  return discardBulkBufferOrchestrated(flowId, entity, fullRead);
}

export async function performStagingMerge(
  options: SyncChunkOptions,
  opts?: { mergePath?: CdcMergePath },
): Promise<{ written: number }> {
  return performStagingMergeOrchestrated(options, opts);
}

export async function performStagingCleanup(
  options: SyncChunkOptions,
): Promise<void> {
  return performStagingCleanupOrchestrated(options);
}
