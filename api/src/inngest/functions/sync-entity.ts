import { inngest } from "../client";
import { Flow } from "../../database/workspace-schema";
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
import { Types } from "mongoose";
import { cdcBackfillCheckpointService } from "../../sync-cdc/sync-state";
import {
  resolveCdcDestinationAdapter,
  hasStagingSupport,
  resolveEntityPartitioning,
  resolveEntityClustering,
} from "../../sync-cdc/adapters/registry";

/**
 * Max steps to use before yielding back to the parent for re-invocation.
 * Leaves headroom below the hard 1000-step Inngest limit.
 */
const STEP_BUDGET = 900;

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
  tableDestination: Record<string, unknown>;
  deleteMode?: string;
  entityLayouts?: Record<string, unknown>[];
  isCdcEnabled: boolean;
  destinationType: string;
  queries?: unknown[];
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

function appendExecutionLog(
  executionId: string | undefined,
  flowId: string,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  metadata?: Record<string, unknown>,
): void {
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
    (updateDoc.$set as Record<string, unknown>)["stats.currentEntity"] = entity;
  }
  if (entity && totalProcessed !== undefined) {
    updateDoc.$max = { [`stats.entityStats.${entity}`]: totalProcessed };
    (updateDoc.$set as Record<string, unknown>)[
      `stats.entityStatus.${entity}`
    ] = "syncing";
  }

  collection
    .updateOne({ _id: new Types.ObjectId(executionId) }, updateDoc)
    .catch(() => {});
}

export const syncBackfillEntityFunction = inngest.createFunction(
  {
    id: "sync-backfill-entity",
    name: "Sync Backfill Entity",
    concurrency: {
      limit: 1,
      key: "event.data.flowId",
    },
    retries: 3,
    cancelOn: [
      {
        event: "flow.cancel",
        if: "async.data.flowId == event.data.flowId",
      },
    ],
  },
  { event: "flow/sync-backfill-entity" },
  async ({ event, step, logger }): Promise<SyncBackfillEntityResult> => {
    const data = event.data as SyncBackfillEntityPayload;
    const {
      flowId,
      entity,
      executionId,
      dataSourceId,
      workspaceId,
      backfill,
      checkpointEnabled,
      cdcBackfillRunId,
      destinationId,
      destinationDatabaseName,
      syncMode,
      syncEngine,
      tableDestination,
      deleteMode,
      entityLayouts,
      isCdcEnabled,
      destinationType,
      queries,
    } = data;

    const safeEntityStepId = entity.replace(/[^a-zA-Z0-9_-]/g, "_");
    let stepsUsed = 0;

    const logExec = (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      metadata?: Record<string, unknown>,
    ) => appendExecutionLog(executionId, flowId, level, message, metadata);

    // ── Mark entity started ──────────────────────────────────────────
    if (executionId) {
      await step.run(`mark-entity-started-${safeEntityStepId}`, async () => {
        const db = Flow.db;
        await db
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
      stepsUsed++;
    }

    // ── Load checkpoint ──────────────────────────────────────────────
    let state: FetchState | undefined;
    if (checkpointEnabled) {
      const checkpointState = (await step.run(
        `load-cdc-backfill-checkpoint-${safeEntityStepId}`,
        async () => {
          return cdcBackfillCheckpointService.loadEntityCheckpoint({
            workspaceId,
            flowId,
            runId: cdcBackfillRunId!,
            entity,
          });
        },
      )) as FetchState | undefined;
      stepsUsed++;
      if (checkpointState) {
        state = checkpointState;
        logger.info("Resuming entity from checkpoint", {
          flowId,
          entity,
          totalProcessed: checkpointState.totalProcessed,
        });
      }
    }

    // ── Resolve bulk path options ────────────────────────────────────
    const cdcAdapter =
      isCdcEnabled && destinationType && (tableDestination as any)?.connectionId
        ? resolveCdcDestinationAdapter({
            destinationType,
            destinationDatabaseId: destinationId,
            destinationDatabaseName,
            tableDestination: {
              connectionId: String((tableDestination as any).connectionId),
              schema: (tableDestination as any).schema || "public",
              tableName: (tableDestination as any).tableName || "",
            },
          })
        : undefined;
    const useBulkPath = isCdcEnabled && hasStagingSupport(cdcAdapter);
    let flushIndex = 0;
    let bulkSyncOptions: Record<string, unknown> | undefined;

    if (useBulkPath) {
      const bulkEntityLayout = (entityLayouts || []).find(
        (l: any) => l.entity === entity || l.entity === entity.split(":")[0],
      );

      const bulkLogger: SyncLogger = {
        log: (level: string, message: string, metadata?: any) => {
          const logData = { flowId, entity, executionId, ...metadata };
          switch (level) {
            case "info":
              logger.info(message, logData);
              logExec("info", message, logData);
              break;
            case "warn":
              logger.warn(message, logData);
              logExec("warn", message, logData);
              break;
            case "error":
              logger.error(message, logData);
              logExec("error", message, logData);
              break;
            default:
              logger.debug(message, logData);
              break;
          }
        },
      };

      bulkSyncOptions = {
        dataSourceId,
        destinationId,
        destinationDatabaseName,
        flowId,
        workspaceId,
        syncEngine,
        entity,
        isIncremental: syncMode === "incremental",
        tableDestination,
        deleteMode,
        entityPartitioning: resolveEntityPartitioning(
          bulkEntityLayout as any,
          (tableDestination as any)?.partitioning,
        ),
        entityClustering: resolveEntityClustering(
          bulkEntityLayout as any,
          (tableDestination as any)?.clustering,
        ),
        logger: bulkLogger,
      };

      await step.run(`prepare-staging-${safeEntityStepId}`, async () => {
        await touchHeartbeat(executionId);

        // Rescue orphaned staging data from a previously crashed invocation
        // before dropping the staging table.
        try {
          const rescued = await performStagingMerge(bulkSyncOptions as any);
          if (rescued.written > 0) {
            logExec(
              "info",
              `Rescued ${rescued.written} orphaned staging rows into live table before fresh start`,
              { entity, rescued: rescued.written },
            );
          }
        } catch {
          // Staging table may not exist — that's fine
        }

        await performPrepareStaging(bulkSyncOptions as any);
      });
      stepsUsed++;
    }

    // ── Chunk loop ───────────────────────────────────────────────────
    let chunkIndex = 0;
    let completed = false;
    let totalWrittenForEntity = 0;

    while (!completed) {
      if (stepsUsed >= STEP_BUDGET) {
        if (checkpointEnabled && state) {
          await step.run(
            `save-checkpoint-before-yield-${safeEntityStepId}`,
            async () => {
              await cdcBackfillCheckpointService.saveEntityCheckpoint({
                workspaceId,
                flowId,
                runId: cdcBackfillRunId!,
                entity,
                fetchState: state!,
              });
            },
          );
        }
        logger.info(
          `Entity ${entity} yielding to parent after ${stepsUsed} steps (chunk ${chunkIndex})`,
          { flowId, entity, stepsUsed, chunkIndex },
        );
        return { completed: false, rowsWritten: totalWrittenForEntity };
      }

      const chunkResult = await step.run(
        `sync-${entity}-chunk-${chunkIndex}`,
        async () => {
          logger.info("Executing chunk", { flowId, entity, chunkIndex });

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
                  logExec("debug", message, logData);
                  break;
                case "info":
                  logger.info(message, logData);
                  logExec("info", message, logData);
                  break;
                case "warn":
                  logger.warn(message, logData);
                  logExec("warn", message, logData);
                  break;
                case "error":
                  logger.error(message, logData);
                  logExec("error", message, logData);
                  break;
                default:
                  logger.info(message, logData);
                  logExec("info", message, logData);
                  break;
              }
            },
          };

          let resolvedTableDest: Record<string, unknown> =
            tableDestination as Record<string, unknown>;
          if (tableDestination && entityLayouts) {
            const entityLayout = (entityLayouts || []).find(
              (l: any) =>
                l.entity === entity || l.entity === entity.split(":")[0],
            );
            if (entityLayout) {
              const p = resolveEntityPartitioning(
                entityLayout as any,
                (tableDestination as any)?.partitioning,
              );
              const c = resolveEntityClustering(
                entityLayout as any,
                (tableDestination as any)?.clustering,
              );
              resolvedTableDest = {
                ...tableDestination,
                partitioning: p ? { enabled: true, ...p } : undefined,
                clustering: c ? { enabled: true, ...c } : undefined,
              };
            }
          }

          const result = await performSyncChunk({
            dataSourceId,
            destinationId,
            destinationDatabaseName,
            flowId,
            workspaceId,
            syncEngine,
            backfillRunId: backfill
              ? cdcBackfillRunId || executionId
              : undefined,
            entity,
            isIncremental: syncMode === "incremental",
            state,
            maxIterations: 5,
            logger: syncLogger,
            step,
            queries,
            tableDestination: resolvedTableDest,
            deleteMode,
          } as any);

          const written = Number.isFinite(result.totalWritten)
            ? result.totalWritten
            : result.state.totalProcessed;
          const fetched = Number.isFinite(result.totalFetched)
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
                    [`stats.entityStats.${entity}`]: written,
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
                            ? `${entity} sync completed (${written} written, ${fetched} fetched)`
                            : `${entity} sync in progress (${written} written, ${fetched} fetched)`,
                          metadata: {
                            flowId,
                            executionId,
                            entity,
                            chunkIndex,
                            totalProcessed: written,
                            totalWritten: written,
                            totalFetched: fetched,
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
      stepsUsed++;

      state = chunkResult.state;
      completed = chunkResult.completed;
      totalWrittenForEntity = Number.isFinite(chunkResult.totalWritten)
        ? chunkResult.totalWritten
        : chunkResult.state.totalProcessed;

      if (checkpointEnabled && chunkIndex % 10 === 9) {
        await step.run(
          `save-cdc-backfill-checkpoint-${safeEntityStepId}-${chunkIndex}`,
          async () => {
            await cdcBackfillCheckpointService.saveEntityCheckpoint({
              workspaceId,
              flowId,
              runId: cdcBackfillRunId!,
              entity,
              fetchState: chunkResult.state,
            });
          },
        );
        stepsUsed++;
      }
      chunkIndex++;

      if (useBulkPath && bulkSyncOptions && !completed) {
        const tempCount = await step.run(
          `count-temp-${safeEntityStepId}-${chunkIndex}`,
          async () => {
            await touchHeartbeat(executionId);
            const count = await getTempCollectionCount(flowId, entity);
            logger.info("Temp collection row count", {
              flowId,
              entity,
              tempCount: count,
              chunkIndex,
            });
            return count;
          },
        );
        stepsUsed++;

        if (tempCount >= 10_000) {
          await step.run(
            `flush-merge-${safeEntityStepId}-${flushIndex}`,
            async () => {
              await touchHeartbeat(executionId);
              logExec(
                "info",
                `Flushing ${entity} buffer batch ${flushIndex} to live (${tempCount} rows in temp)`,
                { entity, flushIndex, tempCount },
              );
              await performPrepareStaging(bulkSyncOptions as any);
              await performBulkFlush(bulkSyncOptions as any);
              await performStagingMerge(bulkSyncOptions as any);
              await performStagingCleanup(bulkSyncOptions as any);
            },
          );
          stepsUsed++;
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
    });

    // ── Flush remaining + merge for bulk path ─────────────────────────
    if (useBulkPath && bulkSyncOptions) {
      const finalRowsInTemp = await step.run(
        `count-temp-final-${safeEntityStepId}`,
        async () => {
          await touchHeartbeat(executionId);
          const count = await getTempCollectionCount(flowId, entity);
          logger.info("Final temp collection row count before flush", {
            flowId,
            entity,
            tempCount: count,
          });
          return count;
        },
      );

      if (finalRowsInTemp > 0) {
        await step.run(`flush-final-${safeEntityStepId}`, async () => {
          await touchHeartbeat(executionId);
          logExec(
            "info",
            `Flushing ${entity} remaining buffer to staging (${finalRowsInTemp} rows)`,
            { entity, tempCount: finalRowsInTemp },
          );
          await performPrepareStaging(bulkSyncOptions as any);
          await performBulkFlush(bulkSyncOptions as any);
        });

        await step.run(`merge-final-${safeEntityStepId}`, async () => {
          await touchHeartbeat(executionId);
          logExec("info", `Merging ${entity} staging table to live`, {
            entity,
          });
          await performStagingMerge(bulkSyncOptions as any);
          await performStagingCleanup(bulkSyncOptions as any);
          logExec(
            "info",
            `✅ ${entity} bulk backfill complete (buffer → Parquet → staging → live)`,
            { entity },
          );
        });
      }

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

    // ── Mark checkpoint completed ────────────────────────────────────
    if (checkpointEnabled && state) {
      await step.run(
        `complete-cdc-backfill-checkpoint-${safeEntityStepId}`,
        async () => {
          await cdcBackfillCheckpointService.markEntityCompleted({
            workspaceId,
            flowId,
            runId: cdcBackfillRunId!,
            entity,
            fetchState: state,
          });
        },
      );
    }

    return { completed: true, rowsWritten: totalWrittenForEntity };
  },
);
