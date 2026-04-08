import { inngest } from "../client";
import { Flow, IFlow } from "../../database/workspace-schema";
import {
  performSyncChunk,
  performBulkFlush,
  performPrepareStaging,
  getTempCollectionCount,
  performStagingMerge,
  performStagingCleanup,
  SyncLogger,
} from "../../services/sync-executor.service";
import { FetchState } from "../../connectors/base/BaseConnector";
import { cdcBackfillCheckpointService } from "../../sync-cdc/sync-state";
import { Types } from "mongoose";
import { loggers } from "../../logging";

const logger = loggers.inngest("sync-entity");

const STEP_BUDGET_LIMIT = 900;

export interface SyncBackfillEntityPayload {
  flowId: string;
  entity: string;
  executionId?: string;
  dataSourceId: string;
  workspaceId: string;
  backfill?: boolean;
  backfillRunId?: string;
  checkpointEnabled: boolean;
  cdcBackfillRunId?: string;
  destinationId: string;
  destinationDatabaseName?: string;
  syncMode: string;
  syncEngine?: string;
  tableDestination?: Record<string, unknown>;
  deleteMode?: string;
  entityLayouts?: Record<string, unknown>[];
  queries?: unknown[];
  isCdcEnabled: boolean;
  destinationType?: string;
}

export interface SyncBackfillEntityResult {
  completed: boolean;
  rowsWritten: number;
}

function touchHeartbeat(executionId: string | undefined): Promise<void> {
  if (!executionId) return Promise.resolve();
  return Flow.db
    .collection("flow_executions")
    .updateOne(
      { _id: new Types.ObjectId(executionId) },
      { $set: { lastHeartbeat: new Date() } },
    )
    .then(() => {})
    .catch(() => {});
}

function makeAppendExecutionLog(
  flowId: string,
  executionId: string | undefined,
) {
  return (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    metadata?: Record<string, unknown>,
  ) => {
    if (!executionId) return;
    const db = Flow.db;
    const collection = db.collection("flow_executions");
    const entity =
      metadata && typeof metadata.entity === "string"
        ? metadata.entity
        : undefined;
    const totalProcessed =
      metadata && typeof metadata.totalProcessed === "number"
        ? metadata.totalProcessed
        : undefined;

    const updateDoc: Record<string, unknown> = {
      $set: { lastHeartbeat: new Date() },
      $push: {
        logs: {
          $each: [
            {
              timestamp: new Date(),
              level,
              message,
              metadata: { flowId, executionId, ...metadata },
            },
          ],
          $slice: -200,
        },
      },
    };

    if (entity) {
      (updateDoc.$set as Record<string, unknown>)["stats.currentEntity"] =
        entity;
    }
    if (entity && totalProcessed !== undefined) {
      updateDoc.$max = { [`stats.entityStats.${entity}`]: totalProcessed };
      (updateDoc.$set as Record<string, unknown>)[
        `stats.entityStatus.${entity}`
      ] = "syncing";
    }

    return collection
      .updateOne({ _id: new Types.ObjectId(executionId) }, updateDoc)
      .catch(() => {});
  };
}

async function throwIfExecutionCancelled(
  executionId: string | undefined,
  scope: string,
  metadata?: Record<string, unknown>,
) {
  if (!executionId) return;
  const db = Flow.db;
  const execution = await db
    .collection("flow_executions")
    .findOne(
      { _id: new Types.ObjectId(executionId) },
      { projection: { status: 1 } },
    );
  if (execution?.status === "cancelled") {
    logger.warn("Detected cancelled flow execution; stopping entity sync", {
      executionId,
      scope,
      ...metadata,
    });
    const err = new Error("Flow execution cancelled by user");
    (err as Error & { code?: string }).code = "USER_CANCELLED";
    throw err;
  }
}

function resolveBulkSyncOptions(
  data: SyncBackfillEntityPayload,
  entity: string,
  appendExecutionLog: ReturnType<typeof makeAppendExecutionLog>,
): Record<string, unknown> {
  const flowTableDest = data.tableDestination;
  const entityLayout = (data.entityLayouts || []).find(
    (l: any) => l.entity === entity || l.entity === entity.split(":")[0],
  );

  const bulkPartitioning = (entityLayout as any)?.partitionField
    ? {
        type: "time" as const,
        field: (entityLayout as any).partitionField,
        granularity: (entityLayout as any).partitionGranularity || "day",
        requirePartitionFilter: (flowTableDest as any)?.partitioning
          ?.requirePartitionFilter,
      }
    : (flowTableDest as any)?.partitioning?.enabled
      ? {
          type: (flowTableDest as any).partitioning.type || "time",
          field:
            (flowTableDest as any).partitioning.type === "ingestion"
              ? "_syncedAt"
              : (flowTableDest as any).partitioning.field || "_syncedAt",
          granularity: (flowTableDest as any).partitioning.granularity || "day",
          requirePartitionFilter: (flowTableDest as any).partitioning
            .requirePartitionFilter,
        }
      : undefined;

  const bulkClustering = (entityLayout as any)?.clusterFields?.length
    ? { fields: (entityLayout as any).clusterFields }
    : (flowTableDest as any)?.clustering?.enabled &&
        (flowTableDest as any)?.clustering?.fields?.length
      ? { fields: (flowTableDest as any).clustering.fields }
      : undefined;

  const bulkLogger: SyncLogger = {
    log: (level: string, message: string, metadata?: any) => {
      const logData = {
        flowId: data.flowId,
        entity,
        executionId: data.executionId,
        ...metadata,
      };
      switch (level) {
        case "info":
          logger.info(message, logData);
          void appendExecutionLog("info", message, logData);
          break;
        case "warn":
          logger.warn(message, logData);
          void appendExecutionLog("warn", message, logData);
          break;
        case "error":
          logger.error(message, logData);
          void appendExecutionLog("error", message, logData);
          break;
        default:
          logger.debug(message, logData);
          break;
      }
    },
  };

  return {
    dataSourceId: data.dataSourceId,
    destinationId: data.destinationId,
    destinationDatabaseName: data.destinationDatabaseName,
    flowId: data.flowId,
    workspaceId: data.workspaceId,
    syncEngine: data.syncEngine,
    entity,
    isIncremental: data.syncMode === "incremental",
    tableDestination: flowTableDest,
    deleteMode: data.deleteMode,
    entityPartitioning: bulkPartitioning,
    entityClustering: bulkClustering,
    logger: bulkLogger,
  };
}

export const syncBackfillEntityFunction = inngest.createFunction(
  {
    id: "sync-backfill-entity",
    name: "Sync Backfill Entity",
    concurrency: { limit: 1, key: "event.data.flowId" },
    retries: 3,
  },
  { event: "flow/sync-backfill-entity" },
  async ({ event, step }): Promise<SyncBackfillEntityResult> => {
    const data = event.data as SyncBackfillEntityPayload;
    const {
      flowId,
      entity,
      executionId,
      dataSourceId,
      checkpointEnabled,
      cdcBackfillRunId,
      isCdcEnabled,
      destinationType,
      backfill,
    } = data;

    const safeEntityStepId = entity.replace(/[^a-zA-Z0-9_-]/g, "_");
    const appendExecutionLog = makeAppendExecutionLog(flowId, executionId);
    let stepCount = 0;
    let rowsWritten = 0;

    logger.info("Starting entity sync child function", {
      flowId,
      entity,
      checkpointEnabled,
      isCdcEnabled,
      destinationType,
    });

    // Check if already completed via checkpoint
    if (checkpointEnabled && cdcBackfillRunId) {
      const isAlreadyComplete = (await step.run(
        `check-entity-complete-${safeEntityStepId}`,
        async () => {
          const completed =
            await cdcBackfillCheckpointService.listCompletedEntities({
              workspaceId: data.workspaceId,
              flowId,
              runId: cdcBackfillRunId,
            });
          return completed.includes(entity);
        },
      )) as boolean;
      stepCount++;

      if (isAlreadyComplete) {
        logger.info("Entity already completed in checkpointed run", {
          flowId,
          entity,
        });
        if (executionId) {
          await step.run(
            `mark-entity-skipped-${safeEntityStepId}`,
            async () => {
              await Flow.db
                .collection("flow_executions")
                .updateOne({ _id: new Types.ObjectId(executionId) }, {
                  $set: {
                    lastHeartbeat: new Date(),
                    "stats.currentEntity": entity,
                    [`stats.entityStatus.${entity}`]: "completed",
                  },
                  $addToSet: { "stats.syncedEntities": entity },
                } as any);
            },
          );
        }
        return { completed: true, rowsWritten: 0 };
      }
    }

    // Mark entity as started
    if (executionId) {
      await step.run(`mark-entity-started-${safeEntityStepId}`, async () => {
        await Flow.db
          .collection("flow_executions")
          .updateOne({ _id: new Types.ObjectId(executionId) }, {
            $set: {
              lastHeartbeat: new Date(),
              "stats.currentEntity": entity,
              [`stats.entityStatus.${entity}`]: "syncing",
              [`stats.entityStats.${entity}`]: 0,
            },
            $push: {
              logs: {
                $each: [
                  {
                    timestamp: new Date(),
                    level: "info",
                    message: `Starting sync for ${entity}`,
                    metadata: { flowId, executionId, entity },
                  },
                ],
                $slice: -200,
              },
            },
          } as any);
      });
      stepCount++;
    }

    // Load checkpoint state if resuming
    let state: FetchState | undefined;
    if (checkpointEnabled && cdcBackfillRunId) {
      const checkpointState = (await step.run(
        `load-checkpoint-${safeEntityStepId}`,
        async () => {
          return cdcBackfillCheckpointService.loadEntityCheckpoint({
            workspaceId: data.workspaceId,
            flowId,
            runId: cdcBackfillRunId,
            entity,
          });
        },
      )) as FetchState | undefined;
      stepCount++;
      if (checkpointState) {
        state = checkpointState;
        logger.info("Resuming entity from checkpoint", {
          flowId,
          entity,
          totalProcessed: checkpointState.totalProcessed,
          hasMore: checkpointState.hasMore,
        });
      }
    }

    // Build bulk sync options for BigQuery path
    const useBulkPath = isCdcEnabled && destinationType === "bigquery";
    let flushIndex = 0;
    let bulkSyncOptions: Record<string, unknown> | undefined;

    if (useBulkPath) {
      bulkSyncOptions = resolveBulkSyncOptions(
        data,
        entity,
        appendExecutionLog,
      );

      await step.run(`prepare-staging-${safeEntityStepId}`, async () => {
        await touchHeartbeat(executionId);
        void appendExecutionLog(
          "info",
          `Preparing staging table for ${entity} (dropping if exists)`,
          { entity },
        );
        await performPrepareStaging(bulkSyncOptions as any);
      });
      stepCount++;
    }

    // Fetch the flow for sync chunk calls (need full flow object for table destination resolution)
    const flow = (await step.run(
      `load-flow-for-sync-${safeEntityStepId}`,
      async () => {
        const found = await Flow.findById(flowId);
        if (!found) throw new Error(`Flow ${flowId} not found`);
        return found.toObject() as IFlow;
      },
    )) as IFlow;
    stepCount++;

    // Chunk loop
    let chunkIndex = 0;
    let completed = false;

    while (!completed) {
      if (stepCount >= STEP_BUDGET_LIMIT) {
        logger.info(
          "Approaching step budget limit, saving checkpoint for continuation",
          {
            flowId,
            entity,
            stepCount,
            chunkIndex,
            totalProcessed: state?.totalProcessed,
          },
        );

        if (checkpointEnabled && cdcBackfillRunId && state) {
          await step.run(
            `save-checkpoint-before-continue-${safeEntityStepId}`,
            async () => {
              await cdcBackfillCheckpointService.saveEntityCheckpoint({
                workspaceId: data.workspaceId,
                flowId,
                runId: cdcBackfillRunId!,
                entity,
                fetchState: state!,
              });
            },
          );
        }

        if (useBulkPath && bulkSyncOptions) {
          const tempCount = await getTempCollectionCount(flowId, entity);
          if (tempCount > 0) {
            await step.run(
              `flush-before-continue-${safeEntityStepId}`,
              async () => {
                await touchHeartbeat(executionId);
                await performBulkFlush(bulkSyncOptions as any);
              },
            );
          }
        }

        return { completed: false, rowsWritten };
      }

      await throwIfExecutionCancelled(executionId, "before-chunk", {
        entity,
        chunkIndex,
      });

      const chunkResult = await step.run(
        `sync-${safeEntityStepId}-chunk-${chunkIndex}`,
        async () => {
          const syncLogger: SyncLogger = {
            log: (level: string, message: string, metadata?: any) => {
              const logData = {
                flowId,
                entity,
                chunkIndex,
                executionId,
                ...metadata,
              };
              switch (level) {
                case "debug":
                  logger.debug(message, logData);
                  void appendExecutionLog("debug", message, logData);
                  break;
                case "info":
                  logger.info(message, logData);
                  void appendExecutionLog("info", message, logData);
                  break;
                case "warn":
                  logger.warn(message, logData);
                  void appendExecutionLog("warn", message, logData);
                  break;
                case "error":
                  logger.error(message, logData);
                  void appendExecutionLog("error", message, logData);
                  break;
                default:
                  logger.info(message, logData);
                  void appendExecutionLog("info", message, logData);
                  break;
              }
            },
          };

          const flowTableDest = (flow as any).tableDestination;
          let resolvedTableDest = flowTableDest;
          if (flowTableDest && (flow as any).entityLayouts) {
            const entityLayout = ((flow as any).entityLayouts || []).find(
              (l: any) =>
                l.entity === entity || l.entity === entity.split(":")[0],
            );
            if (entityLayout) {
              resolvedTableDest = {
                ...flowTableDest,
                partitioning: {
                  enabled: true,
                  type: "time",
                  field: entityLayout.partitionField,
                  granularity: entityLayout.partitionGranularity || "day",
                },
                clustering: entityLayout.clusterFields?.length
                  ? { enabled: true, fields: entityLayout.clusterFields }
                  : undefined,
              };
            }
          }

          const result = await performSyncChunk({
            dataSourceId,
            destinationId: data.destinationId,
            destinationDatabaseName: data.destinationDatabaseName,
            flowId,
            workspaceId: data.workspaceId,
            syncEngine: data.syncEngine,
            backfillRunId: backfill
              ? cdcBackfillRunId || executionId
              : undefined,
            entity,
            isIncremental: data.syncMode === "incremental",
            state,
            maxIterations: 10,
            logger: syncLogger,
            step,
            queries: data.queries as any[],
            tableDestination: resolvedTableDest,
            deleteMode: data.deleteMode as any,
          });

          const totalWrittenForEntity = Number.isFinite(result.totalWritten)
            ? result.totalWritten
            : result.state.totalProcessed;
          const totalFetchedForEntity = Number.isFinite(result.totalFetched)
            ? result.totalFetched
            : result.state.totalProcessed;

          if (executionId) {
            try {
              await Flow.db
                .collection("flow_executions")
                .updateOne({ _id: new Types.ObjectId(executionId) }, {
                  $set: {
                    lastHeartbeat: new Date(),
                    "stats.currentEntity": entity,
                    [`stats.entityStatus.${entity}`]: result.completed
                      ? "completed"
                      : "syncing",
                    [`stats.entityStats.${entity}`]: totalWrittenForEntity,
                  },
                  ...(result.completed
                    ? { $addToSet: { "stats.syncedEntities": entity } }
                    : {}),
                  $push: {
                    logs: {
                      $each: [
                        {
                          timestamp: new Date(),
                          level: "info",
                          message: result.completed
                            ? `${entity} sync completed (${totalWrittenForEntity} written, ${totalFetchedForEntity} fetched)`
                            : `${entity} sync in progress (${totalWrittenForEntity} written, ${totalFetchedForEntity} fetched)`,
                          metadata: {
                            flowId,
                            executionId,
                            entity,
                            chunkIndex,
                            totalProcessed: totalWrittenForEntity,
                            totalWritten: totalWrittenForEntity,
                            totalFetched: totalFetchedForEntity,
                            hasMore: !result.completed,
                          },
                        },
                      ],
                      $slice: -200,
                    },
                  },
                } as any);
            } catch {
              // non-critical
            }
          }

          return result;
        },
      );
      stepCount++;

      await throwIfExecutionCancelled(executionId, "after-chunk", {
        entity,
        chunkIndex,
      });

      state = chunkResult.state;
      completed = chunkResult.completed;
      rowsWritten = Number.isFinite(chunkResult.totalWritten)
        ? chunkResult.totalWritten
        : chunkResult.state.totalProcessed;

      if (checkpointEnabled && cdcBackfillRunId && chunkIndex % 10 === 9) {
        await step.run(
          `save-checkpoint-${safeEntityStepId}-${chunkIndex}`,
          async () => {
            await cdcBackfillCheckpointService.saveEntityCheckpoint({
              workspaceId: data.workspaceId,
              flowId,
              runId: cdcBackfillRunId!,
              entity,
              fetchState: chunkResult.state,
            });
          },
        );
        stepCount++;
      }
      chunkIndex++;

      if (useBulkPath && bulkSyncOptions && !completed) {
        const tempCount = await getTempCollectionCount(flowId, entity);
        if (tempCount >= 50_000) {
          await step.run(
            `flush-batch-${safeEntityStepId}-${flushIndex}`,
            async () => {
              await touchHeartbeat(executionId);
              void appendExecutionLog(
                "info",
                `Flushing ${entity} buffer batch ${flushIndex} to staging (${tempCount} rows in temp)`,
                { entity, flushIndex, tempCount },
              );
              await performBulkFlush(bulkSyncOptions as any);
            },
          );
          stepCount++;
          flushIndex++;
        }
      }

      if (chunkIndex > 1000) {
        throw new Error(
          `Too many chunks (${chunkIndex}) for entity ${entity}. Possible infinite loop.`,
        );
      }
    }

    logger.info("Completed chunked sync for entity", {
      flowId,
      entity,
      totalChunks: chunkIndex,
      rowsWritten,
    });

    // Final flush, merge, and cleanup for BigQuery bulk path
    if (useBulkPath && bulkSyncOptions) {
      const finalRowsInTemp = await getTempCollectionCount(flowId, entity);
      if (finalRowsInTemp > 0) {
        await step.run(`flush-final-${safeEntityStepId}`, async () => {
          await touchHeartbeat(executionId);
          void appendExecutionLog(
            "info",
            `Flushing ${entity} remaining buffer to BigQuery staging (${finalRowsInTemp} rows)`,
            { entity, tempCount: finalRowsInTemp },
          );
          await performBulkFlush(bulkSyncOptions as any);
        });
        stepCount++;
      }

      try {
        await step.run(`merge-staging-${safeEntityStepId}`, async () => {
          await touchHeartbeat(executionId);
          void appendExecutionLog(
            "info",
            `Merging ${entity} staging table to live`,
            { entity },
          );
          try {
            await performStagingMerge(bulkSyncOptions as any);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await appendExecutionLog(
              "error",
              `Failed to merge ${entity} staging to live: ${msg}`,
              { entity },
            );
            throw err;
          }
          void appendExecutionLog(
            "info",
            `${entity} merged staging to live table`,
            { entity },
          );
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await appendExecutionLog(
          "error",
          `Merge step failed for ${entity}: ${msg}`,
          { entity },
        );
        throw err;
      }

      await step.run(`cleanup-staging-${safeEntityStepId}`, async () => {
        await touchHeartbeat(executionId);
        try {
          await performStagingCleanup(bulkSyncOptions as any);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void appendExecutionLog(
            "error",
            `Failed to cleanup ${entity} staging: ${msg}`,
            { entity },
          );
          throw err;
        }
        void appendExecutionLog(
          "info",
          `✅ ${entity} bulk backfill complete (buffer → Parquet → staging → live)`,
          { entity },
        );
      });

      if (executionId) {
        try {
          await Flow.db.collection("flow_executions").updateOne(
            { _id: new Types.ObjectId(executionId) },
            {
              $set: {
                lastHeartbeat: new Date(),
                [`stats.entityStatus.${entity}`]: "completed",
              },
              $addToSet: { "stats.syncedEntities": entity },
            },
          );
        } catch {
          // non-critical
        }
      }
    }

    // Mark checkpoint as completed
    if (checkpointEnabled && cdcBackfillRunId && state) {
      await step.run(`complete-checkpoint-${safeEntityStepId}`, async () => {
        await cdcBackfillCheckpointService.markEntityCompleted({
          workspaceId: data.workspaceId,
          flowId,
          runId: cdcBackfillRunId!,
          entity,
          fetchState: state,
        });
      });
    }

    logger.info("Entity sync child function completed", {
      flowId,
      entity,
      rowsWritten,
      totalSteps: stepCount,
    });

    return { completed: true, rowsWritten };
  },
);
