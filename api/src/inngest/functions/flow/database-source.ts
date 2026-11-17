/**
 * The database-to-database branch of a flow run: chunked, resumable
 * execution (one Inngest step per chunk), the full-sync staging swap, and the
 * incremental tracking value.
 */
import { inWorkspace } from "../../../utils/workspace-scope";
import { Types } from "mongoose";
import {
  DatabaseConnection,
  Flow,
  type IFlow,
} from "../../../database/workspace-schema";
import {
  createDestinationWriter,
  executeDbSyncChunk,
  getMaxTrackingValue,
  type DbSyncChunkState,
} from "../../../services/destination-writer.service";
import { withHeartbeat } from "../../../services/flow-execution-tracking";
import {
  completeExecutionStep,
  emitSuccessNotification,
  markFlowSucceeded,
} from "./execution-completion";
import type { FlowRunContext } from "./run-context";

type DatabaseSource = NonNullable<IFlow["databaseSource"]>;

/**
 * The destination writer for a database-source flow. A MongoDB destination
 * without a table name writes to `<source connection>_sync`.
 */
export async function createDbSourceWriter(
  flow: IFlow,
  dbSource: Pick<DatabaseSource, "connectionId">,
  sourceConnection: { name: string } | null | undefined,
) {
  const destinationWriter = await createDestinationWriter(
    {
      workspaceId: flow.workspaceId,
      destinationDatabaseId: flow.destinationDatabaseId,
      destinationDatabaseName: flow.destinationDatabaseName,
      tableDestination: flow.tableDestination,
      dataSourceId: dbSource.connectionId,
    },
    sourceConnection?.name,
  );

  if (!flow.tableDestination?.tableName && sourceConnection) {
    destinationWriter.setCollectionName(`${sourceConnection.name}_sync`);
  }
  return destinationWriter;
}

export async function runDatabaseSourceFlow(
  ctx: FlowRunContext,
  flow: IFlow,
): Promise<{
  success: true;
  message: string;
  totalRows: number;
  chunks: number;
}> {
  const { step, logger, flowId } = ctx;
  const { executionId } = ctx.state;
  const throwIfExecutionCancelled = ctx.throwIfExecutionCancelled;

  // Validate database source configuration up-front so TypeScript can
  // narrow `flow.databaseSource` for the remainder of this branch.
  if (!flow.databaseSource?.connectionId || !flow.databaseSource?.query) {
    throw new Error("Database source requires connectionId and query");
  }
  const dbSource = flow.databaseSource;

  logger.info("Starting database-to-database sync with chunked execution", {
    flowId,
    syncMode: flow.syncMode,
    sourceConnectionId: dbSource.connectionId.toString(),
    sourceDatabase: dbSource.database,
  });

  await step.run("validate-db-source", async () => {
    const sourceConnection = await DatabaseConnection.findOne(
      inWorkspace(dbSource.connectionId, flow.workspaceId),
    );
    if (!sourceConnection) {
      throw new Error(
        `Source database connection not found: ${dbSource.connectionId}`,
      );
    }

    return {
      sourceConnectionId: sourceConnection._id.toString(),
      sourceName: sourceConnection.name,
    };
  });

  // Initialize destination writer once
  await step.run("init-destination-writer", async () => {
    const sourceConnection = await DatabaseConnection.findOne(
      inWorkspace(dbSource.connectionId, flow.workspaceId),
    );

    const destinationWriter = await createDbSourceWriter(
      flow,
      dbSource,
      sourceConnection,
    );

    return {
      collectionName: destinationWriter.getCollectionName(),
      isTableDestination: destinationWriter.isTableDestination(),
    };
  });

  // Chunked execution loop
  let chunkState: DbSyncChunkState | undefined;
  let chunkIndex = 0;
  let completed = false;
  let totalRowsProcessed = 0;

  while (!completed) {
    await throwIfExecutionCancelled("db-sync-before-chunk", {
      chunkIndex,
      totalRowsProcessed,
    });
    const chunkResult = await step.run(
      `db-sync-chunk-${chunkIndex}`,
      // One chunk is up to 5k rows read + written: keep the run alive.
      () =>
        withHeartbeat(executionId, async () => {
          logger.info("Executing database sync chunk", {
            flowId,
            chunkIndex,
            offset: chunkState?.offset || 0,
            totalProcessed: chunkState?.totalProcessed || 0,
          });

          // Re-create destination writer for this chunk
          const sourceConnection = await DatabaseConnection.findOne(
            inWorkspace(dbSource.connectionId, flow.workspaceId),
          );
          if (!sourceConnection) {
            throw new Error("Source connection not found");
          }

          const destinationWriter = await createDbSourceWriter(
            flow,
            dbSource,
            sourceConnection,
          );

          // Execute chunk with pagination and type coercions
          const result = await executeDbSyncChunk({
            sourceConnection,
            sourceQuery: dbSource.query,
            sourceDatabase: dbSource.database,
            destinationWriter,
            batchSize: flow.batchSize || 2000,
            syncMode: flow.syncMode,
            incrementalConfig: flow.incrementalConfig,
            paginationConfig: flow.paginationConfig,
            typeCoercions: flow.typeCoercions,
            keyColumns: flow.conflictConfig?.keyColumns,
            state: chunkState,
            maxRowsPerChunk: 5000, // Process 5k rows per Inngest step to stay within 2GB memory
            onProgress: (processed, estimated) => {
              const progress = estimated
                ? `${processed}/${estimated} (${Math.round((processed / estimated) * 100)}%)`
                : `${processed} rows`;
              logger.info(`Progress: ${progress}`, {
                flowId,
                rowsProcessed: processed,
                estimatedTotal: estimated,
              });
            },
          });

          if (result.error) {
            throw new Error(result.error);
          }

          return result;
        }),
    );
    await throwIfExecutionCancelled("db-sync-after-chunk", {
      chunkIndex,
      rowsProcessed: chunkResult.rowsProcessed,
    });

    // Update state for next iteration
    chunkState = chunkResult.state;
    totalRowsProcessed = chunkState.totalProcessed;
    completed = chunkResult.completed;
    chunkIndex++;

    logger.info("Chunk completed", {
      flowId,
      chunkIndex: chunkIndex - 1,
      rowsInChunk: chunkResult.rowsProcessed,
      totalProcessed: totalRowsProcessed,
      estimatedTotal: chunkState.estimatedTotal,
      completed,
    });

    // Persist heartbeat and progress for live UI updates while running.
    if (executionId) {
      const processedChunk = chunkIndex - 1;
      const rowsInChunk = chunkResult.rowsProcessed;
      const done = completed;
      const total = totalRowsProcessed;
      await step.run(`update-db-progress-${processedChunk}`, async () => {
        const db = Flow.db;
        const collection = db.collection("flow_executions");
        await collection.updateOne({ _id: new Types.ObjectId(executionId) }, {
          $set: {
            lastHeartbeat: new Date(),
            "stats.recordsProcessed": total,
            "stats.entityStats.database_query": total,
            "stats.entityStatus.database_query": done ? "completed" : "syncing",
          },
          ...(done
            ? {
                $addToSet: {
                  "stats.syncedEntities": "database_query",
                },
              }
            : {}),
          $push: {
            logs: {
              $each: [
                {
                  timestamp: new Date(),
                  level: "info",
                  message: `Database chunk ${processedChunk} processed (${total} total rows)`,
                  metadata: {
                    flowId,
                    executionId,
                    entity: "database_query",
                    chunkIndex: processedChunk,
                    rowsProcessed: rowsInChunk,
                    totalProcessed: total,
                  },
                },
              ],
              $slice: -200,
            },
          },
        } as any);
      });
    }
  }

  // Finalize staging table swap for full sync
  if (flow.syncMode === "full") {
    await throwIfExecutionCancelled("db-sync-before-finalize-staging");
    await step.run("finalize-staging-swap", () =>
      withHeartbeat(executionId, async () => {
        logger.info("Finalizing full sync (staging table swap)", {
          flowId,
        });

        const sourceConnection = await DatabaseConnection.findOne(
          inWorkspace(dbSource.connectionId, flow.workspaceId),
        );

        const destinationWriter = await createDbSourceWriter(
          flow,
          dbSource,
          sourceConnection,
        );

        // Mark staging as active and finalize
        destinationWriter.markStagingActive();
        await destinationWriter.finalize();

        logger.info("Staging table swap completed", { flowId });
      }),
    );
  }

  // Update incremental tracking value
  if (
    flow.syncMode === "incremental" &&
    flow.incrementalConfig?.trackingColumn &&
    totalRowsProcessed > 0
  ) {
    const trackingColumn = flow.incrementalConfig.trackingColumn;
    const lastTrackingValue = chunkState?.lastTrackingValue;
    await step.run("update-incremental-tracking", () =>
      withHeartbeat(executionId, async () => {
        logger.info("Updating incremental tracking value", { flowId });

        if (flow.tableDestination?.connectionId) {
          // SQL table destination: query the destination table for max tracking value
          const destConnection = await DatabaseConnection.findOne(
            inWorkspace(flow.tableDestination.connectionId, flow.workspaceId),
          );

          if (destConnection) {
            const maxValueResult = await getMaxTrackingValue(
              destConnection,
              flow.tableDestination.tableName,
              trackingColumn,
              flow.tableDestination.schema,
              flow.tableDestination.database,
            );

            if (maxValueResult.success && maxValueResult.maxValue) {
              await Flow.findByIdAndUpdate(flowId, {
                "incrementalConfig.lastValue": maxValueResult.maxValue,
              });

              logger.info("Incremental tracking updated", {
                flowId,
                trackingColumn,
                newLastValue: maxValueResult.maxValue,
              });
            }
          }
        } else if (lastTrackingValue) {
          // MongoDB destination: use the last tracking value from chunk state
          // (since we can't easily query MongoDB for MAX of an arbitrary column)
          await Flow.findByIdAndUpdate(flowId, {
            "incrementalConfig.lastValue": lastTrackingValue,
          });

          logger.info("Incremental tracking updated (from chunk state)", {
            flowId,
            trackingColumn,
            newLastValue: lastTrackingValue,
          });
        }
      }),
    );
  }

  await markFlowSucceeded(ctx, "db-sync-before-success-mark");

  // Complete execution with proper stats
  await completeExecutionStep(ctx, {
    strict: false,
    stats: {
      recordsProcessed: totalRowsProcessed,
      recordsCreated: totalRowsProcessed,
      recordsUpdated: 0,
      recordsDeleted: 0,
      recordsFailed: 0,
      syncedEntities: ["database_query"],
      estimatedTotal: chunkState?.estimatedTotal,
      chunksProcessed: chunkIndex,
    },
    completedLog: { totalRows: totalRowsProcessed, chunks: chunkIndex },
  });

  await emitSuccessNotification(ctx);

  return {
    success: true,
    message: "Database sync completed successfully",
    totalRows: totalRowsProcessed,
    chunks: chunkIndex,
  };
}
