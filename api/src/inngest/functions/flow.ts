import { inngest } from "../client";
import { enqueueWebhookProcess } from "../webhook-process-enqueue";
import {
  Flow,
  IFlow,
  Connector as DataSource,
  DatabaseConnection,
  WebhookEvent,
} from "../../database/workspace-schema";
import {
  performSync,
  performSyncChunk,
  performBulkFlush,
  performPrepareStaging,
  getTempCollectionCount,
  performStagingMerge,
  performStagingCleanup,
  SyncLogger,
} from "../../services/sync-executor.service";
import {
  createDestinationWriter,
  executeDbSyncChunk,
  getMaxTrackingValue,
  DbSyncChunkState,
} from "../../services/destination-writer.service";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { databaseDataSourceManager } from "../../sync/database-data-source-manager";
import { FetchState } from "../../connectors/base/BaseConnector";
import { Types } from "mongoose";
import * as os from "os";
import { CronExpressionParser } from "cron-parser";
import { getExecutionLogger, getSyncLogger } from "../logging";
import { loggers } from "../../logging";
import {
  cdcBackfillCheckpointService,
  syncMachineService,
} from "../../sync-cdc/sync-state";
import { resolveConfiguredEntities } from "../../sync-cdc/entity-selection";
import { hasCdcDestinationAdapter } from "../../sync-cdc/adapters/registry";
import {
  cdcBackfillService,
  forceDrainCdcFlow,
  markCdcBackfillCompletedForFlow,
  purgeSoftDeletesAfterBackfill,
} from "../../sync-cdc/backfill";

const flowLogger = loggers.inngest("flow");

// Helper function to get flow display name
async function getFlowDisplayName(flow: IFlow): Promise<string> {
  try {
    let sourceName: string;
    let destName: string;

    // Get source name based on source type
    if (flow.sourceType === "database" && flow.databaseSource?.connectionId) {
      const sourceDb = await DatabaseConnection.findById(
        flow.databaseSource.connectionId,
      );
      sourceName =
        sourceDb?.name || flow.databaseSource.connectionId.toString();
    } else if (flow.dataSourceId) {
      const dataSource = await DataSource.findById(flow.dataSourceId);
      sourceName = dataSource?.name || flow.dataSourceId.toString();
    } else {
      sourceName = "Unknown Source";
    }

    // Get destination name
    if (flow.tableDestination?.connectionId) {
      const destDb = await DatabaseConnection.findById(
        flow.tableDestination.connectionId,
      );
      destName = flow.tableDestination.tableName
        ? `${destDb?.name || "DB"}.${flow.tableDestination.tableName}`
        : destDb?.name || flow.tableDestination.connectionId.toString();
    } else {
      const database = await DatabaseConnection.findById(
        flow.destinationDatabaseId,
      );
      destName = database?.name || flow.destinationDatabaseId.toString();
    }

    return `${sourceName} → ${destName}`;
  } catch {
    // Fallback to IDs if lookup fails
    const sourceId =
      flow.sourceType === "database"
        ? flow.databaseSource?.connectionId?.toString()
        : flow.dataSourceId?.toString();
    return `${sourceId || "Unknown"} → ${flow.destinationDatabaseId}`;
  }
}

// Flow execution logging interface
interface FlowExecutionLog {
  timestamp: Date;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata?: any;
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

interface FlowExecutionData {
  _id?: Types.ObjectId;
  flowId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  startedAt: Date;
  completedAt?: Date;
  lastHeartbeat?: Date;
  duration?: number;
  status: "running" | "completed" | "failed" | "cancelled" | "abandoned";
  success: boolean;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  logs: FlowExecutionLog[];
  context: {
    dataSourceId: Types.ObjectId;
    destinationDatabaseId: Types.ObjectId;
    destinationDatabaseName?: string;
    syncMode: "full" | "incremental";
    entityFilter?: string[];
    cronExpression: string;
    timezone: string;
  };
  stats?: {
    recordsProcessed?: number;
    recordsCreated?: number;
    recordsUpdated?: number;
    recordsDeleted?: number;
    recordsFailed?: number;
    syncedEntities?: string[];
  };
  system: {
    workerId: string;
    workerVersion?: string;
    nodeVersion: string;
    hostname: string;
  };
}

// Helper class for managing flow execution logging
class FlowExecutionLogger implements SyncLogger {
  private executionId: Types.ObjectId;
  private startTime: Date;
  private logger;
  private totalRecordsProcessed = 0;
  private syncedEntities: Set<string> = new Set();
  private entityStats: Map<string, number> = new Map();

  constructor(
    private flowId: Types.ObjectId,
    private workspaceId: Types.ObjectId,
    private context: FlowExecutionData["context"],
  ) {
    this.executionId = new Types.ObjectId();
    this.startTime = new Date();
    // Use LogTape logger with execution-specific category
    // All logs from this logger will automatically be stored in database via the sink
    this.logger = getExecutionLogger(
      flowId.toString(),
      this.executionId.toString(),
    );
  }

  // Getter for execution ID
  getExecutionId(): string {
    return this.executionId.toString();
  }

  async start(): Promise<void> {
    const execution: Partial<FlowExecutionData> = {
      _id: this.executionId,
      flowId: this.flowId,
      workspaceId: this.workspaceId,
      startedAt: this.startTime,
      lastHeartbeat: new Date(),
      status: "running",
      success: false,
      // Don't initialize logs field - let LogTape handle it via the database sink
      context: this.context,
      system: {
        workerId: `inngest-${os.hostname()}-${process.pid}`,
        workerVersion: process.env.npm_package_version,
        nodeVersion: process.version,
        hostname: os.hostname(),
      },
    };

    await this.saveExecution(execution);

    // Log with execution context - this will be picked up by the database sink
    this.log("info", `Flow execution started: ${this.context.syncMode} sync`, {
      syncMode: this.context.syncMode,
      dataSourceId: this.context.dataSourceId.toString(),
      destinationDatabaseId: this.context.destinationDatabaseId.toString(),
    });
  }

  // Check if this execution already exists in the database
  async exists(): Promise<boolean> {
    try {
      const db = Flow.db;
      const collection = db.collection("flow_executions");
      const existing = await collection.findOne({ _id: this.executionId });
      return !!existing;
    } catch (error) {
      flowLogger.error("Failed to check flow execution existence", { error });
      return false;
    }
  }

  async updateHeartbeat(): Promise<void> {
    await this.saveExecution({
      lastHeartbeat: new Date(),
    });
  }

  log(level: FlowExecutionLog["level"], message: string, metadata?: any): void {
    // Log to LogTape with execution context
    // The database sink will automatically store these logs
    const logData = {
      flowId: this.flowId.toString(),
      executionId: this.executionId.toString(),
      workspaceId: this.workspaceId.toString(),
      ...metadata,
    };

    switch (level) {
      case "debug":
        this.logger.debug(message, logData);
        break;
      case "info":
        this.logger.info(message, logData);
        break;
      case "warn":
        this.logger.warn(message, logData);
        break;
      case "error":
        this.logger.error(message, logData);
        break;
    }
  }

  // Track sync progress
  trackProgress(entity: string, recordsProcessed: number): void {
    this.syncedEntities.add(entity);
    if (recordsProcessed > 0) {
      this.totalRecordsProcessed += recordsProcessed;
      this.entityStats.set(
        entity,
        (this.entityStats.get(entity) || 0) + recordsProcessed,
      );
    }
  }

  getEntityStats(): Record<string, number> {
    return Object.fromEntries(this.entityStats);
  }

  async complete(
    success: boolean,
    error?: Error,
    stats?: FlowExecutionData["stats"],
  ): Promise<void> {
    const completedAt = new Date();
    const duration = completedAt.getTime() - this.startTime.getTime();

    const finalStats = stats || {
      recordsProcessed: this.totalRecordsProcessed,
      recordsCreated: this.totalRecordsProcessed,
      recordsUpdated: 0,
      recordsDeleted: 0,
      recordsFailed: 0,
      syncedEntities: Array.from(this.syncedEntities),
      entityStats: Object.fromEntries(this.entityStats),
    };

    const updates: Partial<FlowExecutionData> = {
      completedAt,
      lastHeartbeat: completedAt,
      duration,
      status: success ? "completed" : "failed",
      success,
      stats: finalStats,
    };

    if (error) {
      updates.error = {
        message: error.message,
        stack: error.stack,
        code: (error as any).code,
      };
    }

    await this.saveExecution(updates);

    this.log(
      "info",
      `Flow execution ${success ? "completed" : "failed"} in ${duration}ms`,
      {
        duration,
        success,
        stats: finalStats,
        ...(error && { error: error.message }),
      },
    );
  }

  private async saveExecution(data: Partial<FlowExecutionData>): Promise<void> {
    try {
      const db = Flow.db;
      const collection = db.collection("flow_executions");

      // If we're creating a new execution (has _id in data), use upsert
      // Otherwise, update the existing execution
      if (data._id) {
        // Initial creation - use upsert to ensure document exists
        await collection.replaceOne({ _id: data._id }, data as any, {
          upsert: true,
        });
      } else {
        // Subsequent updates - update the existing document
        // Ensure we're using the ObjectId type consistently
        const filter = { _id: this.executionId };
        const update = { $set: data };

        flowLogger.info("Updating flow execution", {
          executionId: this.executionId.toString(),
          filter,
          updateFields: Object.keys(data),
        });

        const result = await collection.updateOne(filter, update);

        // Log if update didn't find the document
        if (result.matchedCount === 0) {
          // Check if document exists with string ID
          const existsWithStringId = await collection.findOne({
            _id: this.executionId.toString(),
          } as any);
          if (existsWithStringId) {
            flowLogger.error(
              "Flow execution found with string ID instead of ObjectId",
              {
                executionId: this.executionId.toString(),
              },
            );
          }

          flowLogger.error(
            "Failed to update flow execution - document not found",
            {
              executionId: this.executionId.toString(),
            },
          );
          throw new Error(
            `Flow execution document not found: ${this.executionId}`,
          );
        }

        // Log successful updates for debugging
        if (data.status || data.completedAt) {
          flowLogger.info("Flow execution updated", {
            executionId: this.executionId.toString(),
            status: data.status,
            completedAt: data.completedAt,
            success: data.success,
            modifiedCount: result.modifiedCount,
          });
        }
      }
    } catch (error) {
      flowLogger.error("Failed to save flow execution", {
        error,
        executionId: this.executionId.toString(),
        updateData: data,
      });
      // Re-throw the error so it can be handled properly
      throw error;
    }
  }
}

// The flow function
export const flowFunction = inngest.createFunction(
  {
    id: "flow",
    name: "Execute Flow",
    concurrency: {
      limit: 1, // Only one execution per flow at a time
      key: "event.data.flowId", // Prevent duplicate executions of the same flow
    },
    retries: 10,
    cancelOn: [
      {
        event: "flow.cancel",
        if: "async.data.flowId == event.data.flowId",
      },
    ],
  },
  { event: "flow.execute" },
  async ({ event, step, logger }) => {
    const { flowId, noJitter, backfill, backfillRunId, backfillEntities } =
      event.data as {
        flowId: string;
        noJitter?: boolean;
        backfill?: boolean;
        backfillRunId?: string;
        backfillEntities?: string[];
      };
    const requestedBackfillEntities = Array.isArray(backfillEntities)
      ? Array.from(
          new Set(
            backfillEntities
              .filter(
                (entity): entity is string =>
                  typeof entity === "string" && entity.trim().length > 0,
              )
              .map(entity => entity.trim()),
          ),
        )
      : [];

    logger.info("Flow function started", {
      flowId,
      eventData: event.data,
    });

    // Initialize execution ID for tracking
    let executionId: string | undefined;
    // Store flow ref for use in error handler
    let flowRef: IFlow | undefined;
    let cdcBackfillRunId: string | undefined;

    // Helper to create the execution logger
    const createExecutionLogger = (flow: IFlow): FlowExecutionLogger => {
      const execLogger = new FlowExecutionLogger(
        new Types.ObjectId(flowId),
        new Types.ObjectId(flow.workspaceId),
        {
          dataSourceId: new Types.ObjectId(flow.dataSourceId),
          destinationDatabaseId: new Types.ObjectId(flow.destinationDatabaseId),
          destinationDatabaseName: flow.destinationDatabaseName,
          syncMode: flow.syncMode === "incremental" ? "incremental" : "full",
          entityFilter: resolveConfiguredEntities(flow).entities,
          cronExpression: flow.schedule?.cron || "N/A",
          timezone: flow.schedule?.timezone || "UTC",
        },
      );
      return execLogger;
    };

    // Persist log lines to the execution document so the UI can show live activity.
    // This complements terminal logs from Inngest logger.
    const appendExecutionLog = (
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
                metadata: {
                  flowId,
                  executionId,
                  ...metadata,
                },
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

      // Persist per-batch progress immediately so UI counters move while chunk is running.
      if (entity && totalProcessed !== undefined) {
        updateDoc.$max = {
          [`stats.entityStats.${entity}`]: totalProcessed,
        };
        (updateDoc.$set as Record<string, unknown>)[
          `stats.entityStatus.${entity}`
        ] = "syncing";
      }

      return collection
        .updateOne({ _id: new Types.ObjectId(executionId) }, updateDoc)
        .catch(error => {
          logger.warn("Failed to append execution log", {
            flowId,
            executionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };

    const throwIfExecutionCancelled = async (
      scope: string,
      metadata?: Record<string, unknown>,
    ) => {
      if (!executionId) return;
      const db = Flow.db;
      const collection = db.collection("flow_executions");
      const execution = await collection.findOne(
        { _id: new Types.ObjectId(executionId) },
        { projection: { status: 1 } },
      );

      if (execution?.status === "cancelled") {
        logger.warn("Detected cancelled flow execution; stopping run", {
          flowId,
          executionId,
          scope,
          ...metadata,
        });
        const cancelError = new Error("Flow execution cancelled by user");
        (cancelError as Error & { code?: string }).code = "USER_CANCELLED";
        throw cancelError;
      }
    };

    try {
      // Add jitter to prevent thundering herd - random delay 0-60 seconds
      // Skip jitter if noJitter flag is set
      const jitterMs = await step.run("apply-jitter", async () => {
        if (noJitter) {
          logger.info("Skipping jitter", {
            flowId,
          });
          return 0;
        }

        const jitter = Math.floor(Math.random() * 60000);
        logger.info("Executing flow with jitter", {
          flowId,
          jitterMs: jitter,
        });

        if (jitter > 0) {
          await new Promise(resolve => setTimeout(resolve, jitter));
        }

        return jitter;
      });

      // Use a unique step ID when backfilling to prevent Inngest from replaying
      // stale flow data cached by earlier (possibly pre-CDC) runs.
      const fetchStepSuffix = backfillRunId
        ? `:${backfillRunId.slice(-12)}`
        : "";

      // Get flow details
      const flow = (await step.run(`fetch-flow${fetchStepSuffix}`, async () => {
        const found = await Flow.findById(flowId);
        if (!found) {
          throw new Error(`Flow ${flowId} not found`);
        }
        return found.toObject() as IFlow;
      })) as IFlow;
      flowRef = flow; // Store for error handler

      const destinationType = (await step.run(
        `detect-destination-type${fetchStepSuffix}`,
        async () => {
          if (!flow.tableDestination?.connectionId) return undefined;
          const destination = await DatabaseConnection.findById(
            flow.tableDestination.connectionId,
          )
            .select({ type: 1 })
            .lean();
          return destination?.type || undefined;
        },
      )) as string | undefined;
      const isCdcEnabled =
        flow.syncEngine === "cdc" &&
        Boolean(flow.tableDestination?.connectionId) &&
        hasCdcDestinationAdapter(destinationType);
      const requestedBackfillRunId =
        typeof backfillRunId === "string" && backfillRunId.length > 0
          ? backfillRunId
          : undefined;
      cdcBackfillRunId =
        backfill && flow.type === "webhook" && isCdcEnabled
          ? requestedBackfillRunId || flow.backfillState?.runId
          : undefined;

      // Webhook flows should not be executed unless it's a backfill
      if (flow.type === "webhook" && !backfill) {
        logger.error("CRITICAL: Webhook flow reached flow executor!", {
          flowId,
          flowType: flow.type,
          dataSourceId: flow.dataSourceId,
          schedule: flow.schedule,
          webhookConfig: !!flow.webhookConfig,
        });
        return {
          success: false,
          message: "Webhook flows cannot be executed as scheduled flows",
        };
      }

      // Backfill for webhook-triggered flows should run as full sync.
      // This ensures a complete reload instead of incremental upserts.
      if (backfill && flow.type === "webhook" && !isCdcEnabled) {
        (flow as any).syncMode = "full";
        logger.info("Backfill mode: using full sync for webhook flow", {
          flowId,
        });

        await step.run("enable-webhook-backfill-gate", async () => {
          await Flow.findByIdAndUpdate(flowId, {
            $set: {
              "backfillState.status": "running",
              "backfillState.startedAt": new Date(),
              "backfillState.completedAt": null,
            },
          });
        });
      }

      if (backfill && flow.type === "webhook" && isCdcEnabled) {
        (flow as any).syncMode = "full";
        logger.info(
          "Backfill mode: BigQuery CDC enabled, no webhook apply gate",
          {
            flowId,
          },
        );
        await step.run("cdc-transition-start-backfill", async () => {
          await syncMachineService.applyBackfillTransition({
            workspaceId: String(flow.workspaceId),
            flowId: String(flow._id),
            event: {
              type: "START",
              reason: "Backfill execution started",
            },
            context: {
              hasActiveRunLock: false,
            },
          });
        });
        await step.run("mark-cdc-backfill-active", async () => {
          const now = new Date();
          const update: Record<string, unknown> = {
            "backfillState.status": "running",
            "backfillState.startedAt": flow.backfillState?.startedAt || now,
            "backfillState.completedAt": null,
          };
          if (cdcBackfillRunId) {
            update["backfillState.runId"] = cdcBackfillRunId;
          }
          await Flow.findByIdAndUpdate(flowId, {
            $set: update,
          });
        });
      }

      // Initialize logger and get execution ID
      executionId = await step.run("initialize-logger", async () => {
        const execLogger = createExecutionLogger(flow);
        await execLogger.start();

        const flowDisplayName = await getFlowDisplayName(flow);
        logger.info("Starting flow execution", {
          flowId,
          flowDisplayName,
          jitterApplied: jitterMs,
          executionId: execLogger.getExecutionId(),
          triggerType: noJitter ? "manual" : "scheduled",
        });

        return execLogger.getExecutionId();
      });

      // We have the execution ID, no need to store the logger

      // Update flow status
      const currentRunCount = await step.run("update-flow-status", async () => {
        const result = await Flow.findByIdAndUpdate(
          flowId,
          {
            lastRunAt: new Date(),
            $inc: { runCount: 1 },
          },
          { new: true },
        );
        if (result) {
          return result.runCount;
        }
        return flow.runCount + 1;
      });

      logger.info("Flow run status updated", {
        flowId,
        runCount: currentRunCount,
      });
      await throwIfExecutionCancelled("post-flow-status-update");

      // Validate sync configuration
      await step.run("validate-sync-config", async () => {
        logger.info("Validating sync configuration", {
          flowId,
          sourceType: flow.sourceType || "connector",
          syncMode: flow.syncMode,
          dataSourceId: flow.dataSourceId?.toString(),
          databaseSourceConnectionId:
            flow.databaseSource?.connectionId?.toString(),
          destinationDatabaseId: flow.destinationDatabaseId.toString(),
          tableDestination: flow.tableDestination?.tableName,
          entityFilter: resolveConfiguredEntities(flow).entities,
        });
        return true;
      });

      // Variable to track entities synced
      let syncedEntities: string[] = [];
      const entityStatsMap: Record<string, number> = {};

      // ============ DATABASE SOURCE EXECUTION ============
      // For database-to-database flows, use chunked execution for resumability
      if (flow.sourceType === "database") {
        logger.info(
          "Starting database-to-database sync with chunked execution",
          {
            flowId,
            syncMode: flow.syncMode,
            sourceConnectionId: flow.databaseSource?.connectionId?.toString(),
            sourceDatabase: flow.databaseSource?.database,
          },
        );

        // Validate database source configuration
        const _validation = await step.run("validate-db-source", async () => {
          if (
            !flow.databaseSource?.connectionId ||
            !flow.databaseSource?.query
          ) {
            throw new Error("Database source requires connectionId and query");
          }

          const sourceConnection = await DatabaseConnection.findById(
            flow.databaseSource.connectionId,
          );
          if (!sourceConnection) {
            throw new Error(
              `Source database connection not found: ${flow.databaseSource.connectionId}`,
            );
          }

          return {
            sourceConnectionId: sourceConnection._id.toString(),
            sourceName: sourceConnection.name,
          };
        });

        // Initialize destination writer once
        const _writerConfig = await step.run(
          "init-destination-writer",
          async () => {
            const sourceConnection = await DatabaseConnection.findById(
              flow.databaseSource!.connectionId,
            );

            const destinationWriter = await createDestinationWriter(
              {
                destinationDatabaseId: flow.destinationDatabaseId,
                destinationDatabaseName: flow.destinationDatabaseName,
                tableDestination: flow.tableDestination,
                dataSourceId: flow.databaseSource!.connectionId,
              },
              sourceConnection?.name,
            );

            // Set collection name if writing to MongoDB
            if (!flow.tableDestination?.tableName && sourceConnection) {
              (destinationWriter as any).config.collectionName =
                `${sourceConnection.name}_sync`;
            }

            return {
              collectionName: (destinationWriter as any).config?.collectionName,
              isTableDestination: destinationWriter.isTableDestination(),
            };
          },
        );

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
            async () => {
              logger.info("Executing database sync chunk", {
                flowId,
                chunkIndex,
                offset: chunkState?.offset || 0,
                totalProcessed: chunkState?.totalProcessed || 0,
              });

              // Re-create destination writer for this chunk
              const sourceConnection = await DatabaseConnection.findById(
                flow.databaseSource!.connectionId,
              );
              if (!sourceConnection) {
                throw new Error("Source connection not found");
              }

              const destinationWriter = await createDestinationWriter(
                {
                  destinationDatabaseId: flow.destinationDatabaseId,
                  destinationDatabaseName: flow.destinationDatabaseName,
                  tableDestination: flow.tableDestination,
                  dataSourceId: flow.databaseSource!.connectionId,
                },
                sourceConnection.name,
              );

              if (!flow.tableDestination?.tableName) {
                (destinationWriter as any).config.collectionName =
                  `${sourceConnection.name}_sync`;
              }

              // Execute chunk with pagination and type coercions
              const result = await executeDbSyncChunk({
                sourceConnection,
                sourceQuery: flow.databaseSource!.query,
                sourceDatabase: flow.databaseSource!.database,
                destinationWriter,
                batchSize: flow.batchSize || 2000,
                syncMode: flow.syncMode,
                incrementalConfig: flow.incrementalConfig,
                paginationConfig: flow.paginationConfig,
                typeCoercions: flow.typeCoercions,
                keyColumns: flow.conflictConfig?.keyColumns,
                state: chunkState,
                maxRowsPerChunk: 10000, // Process 10k rows per Inngest step
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
            },
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
            await step.run(`update-db-progress-${chunkIndex - 1}`, async () => {
              const db = Flow.db;
              const collection = db.collection("flow_executions");
              await collection.updateOne(
                { _id: new Types.ObjectId(executionId) },
                {
                  $set: {
                    lastHeartbeat: new Date(),
                    "stats.recordsProcessed": totalRowsProcessed,
                    "stats.entityStats.database_query": totalRowsProcessed,
                    "stats.entityStatus.database_query": completed
                      ? "completed"
                      : "syncing",
                  },
                  ...(completed
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
                          message: `Database chunk ${chunkIndex - 1} processed (${totalRowsProcessed} total rows)`,
                          metadata: {
                            flowId,
                            executionId,
                            entity: "database_query",
                            chunkIndex: chunkIndex - 1,
                            rowsProcessed: chunkResult.rowsProcessed,
                            totalProcessed: totalRowsProcessed,
                          },
                        },
                      ],
                      $slice: -200,
                    },
                  },
                } as any,
              );
            });
          }
        }

        // Finalize staging table swap for full sync
        if (flow.syncMode === "full") {
          await throwIfExecutionCancelled("db-sync-before-finalize-staging");
          await step.run("finalize-staging-swap", async () => {
            logger.info("Finalizing full sync (staging table swap)", {
              flowId,
            });

            const sourceConnection = await DatabaseConnection.findById(
              flow.databaseSource!.connectionId,
            );

            const destinationWriter = await createDestinationWriter(
              {
                destinationDatabaseId: flow.destinationDatabaseId,
                destinationDatabaseName: flow.destinationDatabaseName,
                tableDestination: flow.tableDestination,
                dataSourceId: flow.databaseSource!.connectionId,
              },
              sourceConnection?.name,
            );

            if (!flow.tableDestination?.tableName && sourceConnection) {
              (destinationWriter as any).config.collectionName =
                `${sourceConnection.name}_sync`;
            }

            // Mark staging as active and finalize
            (destinationWriter as any).stagingActive = true;
            await destinationWriter.finalize();

            logger.info("Staging table swap completed", { flowId });
          });
        }

        // Update incremental tracking value
        if (
          flow.syncMode === "incremental" &&
          flow.incrementalConfig?.trackingColumn &&
          totalRowsProcessed > 0
        ) {
          await step.run("update-incremental-tracking", async () => {
            logger.info("Updating incremental tracking value", { flowId });

            if (flow.tableDestination?.connectionId) {
              // SQL table destination: query the destination table for max tracking value
              const destConnection = await DatabaseConnection.findById(
                flow.tableDestination.connectionId,
              );

              if (destConnection) {
                const maxValueResult = await getMaxTrackingValue(
                  destConnection,
                  flow.tableDestination.tableName,
                  flow.incrementalConfig!.trackingColumn,
                  flow.tableDestination.schema,
                  flow.tableDestination.database,
                );

                if (maxValueResult.success && maxValueResult.maxValue) {
                  await Flow.findByIdAndUpdate(flowId, {
                    "incrementalConfig.lastValue": maxValueResult.maxValue,
                  });

                  logger.info("Incremental tracking updated", {
                    flowId,
                    trackingColumn: flow.incrementalConfig!.trackingColumn,
                    newLastValue: maxValueResult.maxValue,
                  });
                }
              }
            } else if (chunkState?.lastTrackingValue) {
              // MongoDB destination: use the last tracking value from chunk state
              // (since we can't easily query MongoDB for MAX of an arbitrary column)
              await Flow.findByIdAndUpdate(flowId, {
                "incrementalConfig.lastValue": chunkState.lastTrackingValue,
              });

              logger.info("Incremental tracking updated (from chunk state)", {
                flowId,
                trackingColumn: flow.incrementalConfig!.trackingColumn,
                newLastValue: chunkState.lastTrackingValue,
              });
            }
          });
        }

        // Skip connector-based execution
        syncedEntities = ["database_query"];

        // Update success status
        await throwIfExecutionCancelled("db-sync-before-success-mark");
        await step.run("update-success-status", async () => {
          logger.info("Updating flow success status", { flowId });
          await Flow.findByIdAndUpdate(flowId, {
            lastSuccessAt: new Date(),
            lastError: null,
          });
        });

        // Complete execution with proper stats
        await step.run("complete-execution", async () => {
          logger.info("Completing execution logging", { flowId, executionId });

          if (executionId) {
            const db = Flow.db;
            const collection = db.collection("flow_executions");
            const completedAt = new Date();

            const updateResult = await collection.updateOne(
              {
                _id: new Types.ObjectId(executionId),
                status: { $in: ["running", "abandoned", "failed"] },
              },
              {
                $set: {
                  completedAt,
                  lastHeartbeat: completedAt,
                  status: "completed",
                  success: true,
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
                },
              },
            );

            if (updateResult.matchedCount === 0) {
              const current = await collection.findOne(
                { _id: new Types.ObjectId(executionId) },
                { projection: { status: 1 } },
              );
              if (current?.status === "cancelled") {
                logger.info(
                  "Skipping completion update because execution is cancelled",
                  {
                    flowId,
                    executionId,
                  },
                );
                return;
              }
            }

            const execution = await collection.findOne({
              _id: new Types.ObjectId(executionId),
            });
            if (execution?.startedAt) {
              const duration =
                completedAt.getTime() - new Date(execution.startedAt).getTime();
              await collection.updateOne(
                { _id: new Types.ObjectId(executionId) },
                { $set: { duration } },
              );

              logger.info("Execution completed successfully", {
                flowId,
                executionId,
                duration,
                totalRows: totalRowsProcessed,
                chunks: chunkIndex,
              });
            }
          }
        });

        return {
          success: true,
          message: "Database sync completed successfully",
          totalRows: totalRowsProcessed,
          chunks: chunkIndex,
        };
      }

      // ============ CONNECTOR SOURCE EXECUTION ============
      // Ensure dataSourceId is defined for connector execution
      if (!flow.dataSourceId) {
        throw new Error(
          "Flow dataSourceId is required for connector execution",
        );
      }
      const dataSourceId = flow.dataSourceId;

      // Check if connector supports chunked execution
      const supportsChunking = await step.run(
        "check-chunking-support",
        async () => {
          const dataSource = await databaseDataSourceManager.getDataSource(
            dataSourceId.toString(),
          );
          if (!dataSource) {
            throw new Error(`Data source not found: ${dataSourceId}`);
          }

          const connector =
            await syncConnectorRegistry.getConnector(dataSource);
          if (!connector) {
            throw new Error(
              `Failed to create connector for type: ${dataSource.type}`,
            );
          }

          const supports = connector.supportsResumableFetching();
          logger.info("Connector chunking support check", {
            flowId,
            connectorType: dataSource.type,
            supportsChunking: supports,
          });
          return supports;
        },
      );

      if (supportsChunking) {
        const checkpointEnabled =
          Boolean(backfill) &&
          flow.type === "webhook" &&
          isCdcEnabled &&
          Boolean(cdcBackfillRunId);
        let checkpointCompletedEntities = new Set<string>();
        if (checkpointEnabled) {
          const completedEntities = (await step.run(
            "load-cdc-backfill-completed-entities",
            async () => {
              return cdcBackfillCheckpointService.listCompletedEntities({
                workspaceId: String(flow.workspaceId),
                flowId: String(flow._id),
                runId: cdcBackfillRunId!,
              });
            },
          )) as string[];
          checkpointCompletedEntities = new Set(completedEntities);
          logger.info("Loaded CDC backfill checkpoints", {
            flowId,
            runId: cdcBackfillRunId,
            completedEntities: completedEntities.length,
          });
        }

        // Get entities to sync
        const entitiesToSync = await step.run(
          "get-entities-to-sync",
          async () => {
            const dataSource = await databaseDataSourceManager.getDataSource(
              dataSourceId.toString(),
            );
            if (!dataSource) {
              throw new Error(`Data source not found: ${dataSourceId}`);
            }

            // Inject flow queries into dataSource for GraphQL/PostHog connectors
            // The registry maps connection -> config when creating the connector
            const flowQueries = (flow as any).queries;
            if (flowQueries && flowQueries.length > 0) {
              dataSource.connection = {
                ...dataSource.connection,
                queries: flowQueries,
              };
            }

            const connector =
              await syncConnectorRegistry.getConnector(dataSource);
            if (!connector) {
              throw new Error(
                `Failed to create connector for type: ${dataSource.type}`,
              );
            }

            // Filter entities to skip incomplete/malformed configurations (e.g., empty query bodies)
            const availableEntities = connector
              .getAvailableEntities()
              .filter(e => typeof e === "string" && e.trim().length > 0);
            const { entities: configuredEntities, hasExplicitSelection } =
              resolveConfiguredEntities(flow);
            const scopedBackfillEntities =
              requestedBackfillEntities.length > 0
                ? requestedBackfillEntities
                : backfill &&
                    flow.backfillState?.scope?.mode === "subset" &&
                    Array.isArray(flow.backfillState.scope.entities)
                  ? flow.backfillState.scope.entities
                  : [];

            if (hasExplicitSelection) {
              // Validate requested entities
              const invalidEntities = configuredEntities.filter(
                e => !availableEntities.includes(e),
              );
              if (invalidEntities.length > 0) {
                throw new Error(
                  `Invalid entities: ${invalidEntities.join(", ")}. Available: ${availableEntities.join(", ")}`,
                );
              }
              if (backfill && scopedBackfillEntities.length > 0) {
                const invalidScope = scopedBackfillEntities.filter(
                  entity => !configuredEntities.includes(entity),
                );
                if (invalidScope.length > 0) {
                  throw new Error(
                    `Invalid backfill scope entities: ${invalidScope.join(", ")}. Configured entities: ${configuredEntities.join(", ")}`,
                  );
                }
                return scopedBackfillEntities;
              }
              return configuredEntities;
            }

            if (backfill && scopedBackfillEntities.length > 0) {
              const invalidScope = scopedBackfillEntities.filter(
                entity => !availableEntities.includes(entity),
              );
              if (invalidScope.length > 0) {
                throw new Error(
                  `Invalid backfill scope entities: ${invalidScope.join(", ")}. Available entities: ${availableEntities.join(", ")}`,
                );
              }
              return scopedBackfillEntities;
            }
            return availableEntities;
          },
        );

        // Track the entities we're syncing
        syncedEntities = entitiesToSync;

        // Initialize entity progress so UI can render all entities immediately
        // with "pending" before each entity actually starts.
        if (executionId) {
          await step.run("initialize-entity-progress", async () => {
            const db = Flow.db;
            const collection = db.collection("flow_executions");
            const pendingEntityStatus = Object.fromEntries(
              entitiesToSync.map(entity => [entity, "pending"]),
            );
            const initialEntityStats = Object.fromEntries(
              entitiesToSync.map(entity => [entity, 0]),
            );

            await collection.updateOne(
              { _id: new Types.ObjectId(executionId) },
              {
                $set: {
                  lastHeartbeat: new Date(),
                  "stats.plannedEntities": entitiesToSync,
                  "stats.entityStatus": pendingEntityStatus,
                  "stats.entityStats": initialEntityStats,
                  "stats.recordsProcessed": 0,
                },
              },
            );
          });
        }

        // Process each entity with chunked execution
        for (const entity of entitiesToSync) {
          const safeEntityStepId = entity.replace(/[^a-zA-Z0-9_-]/g, "_");
          await throwIfExecutionCancelled("connector-before-entity", {
            entity,
          });
          if (checkpointEnabled && checkpointCompletedEntities.has(entity)) {
            logger.info(
              "Skipping entity already completed in checkpointed run",
              {
                flowId,
                entity,
                runId: cdcBackfillRunId,
              },
            );
            entityStatsMap[entity] = Math.max(entityStatsMap[entity] || 0, 1);
            if (executionId) {
              await step.run(
                `mark-entity-skipped-${safeEntityStepId}`,
                async () => {
                  const db = Flow.db;
                  const collection = db.collection("flow_executions");
                  await collection.updateOne(
                    { _id: new Types.ObjectId(executionId) },
                    {
                      $set: {
                        lastHeartbeat: new Date(),
                        "stats.currentEntity": entity,
                        [`stats.entityStatus.${entity}`]: "completed",
                      },
                      $addToSet: {
                        "stats.syncedEntities": entity,
                      },
                    } as any,
                  );
                },
              );
            }
            continue;
          }

          logger.info("Starting chunked sync for entity", {
            flowId,
            entity,
          });

          if (executionId) {
            await step.run(
              `mark-entity-started-${safeEntityStepId}`,
              async () => {
                const db = Flow.db;
                const collection = db.collection("flow_executions");
                await collection.updateOne(
                  { _id: new Types.ObjectId(executionId) },
                  {
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
                            metadata: {
                              flowId,
                              executionId,
                              entity,
                            },
                          },
                        ],
                        $slice: -200,
                      },
                    },
                  } as any,
                );
              },
            );
          }

          let state: FetchState | undefined;
          if (checkpointEnabled) {
            const checkpointState = (await step.run(
              `load-cdc-backfill-checkpoint-${safeEntityStepId}`,
              async () => {
                return cdcBackfillCheckpointService.loadEntityCheckpoint({
                  workspaceId: String(flow.workspaceId),
                  flowId: String(flow._id),
                  runId: cdcBackfillRunId!,
                  entity,
                });
              },
            )) as FetchState | undefined;
            if (checkpointState) {
              state = checkpointState;
              logger.info("Resuming entity from checkpoint", {
                flowId,
                entity,
                runId: cdcBackfillRunId,
                totalProcessed: checkpointState.totalProcessed,
                hasMore: checkpointState.hasMore,
              });
            }
          }
          const useBulkPath = isCdcEnabled && destinationType === "bigquery";
          let flushIndex = 0;
          let bulkSyncOptions: Record<string, unknown> | undefined;

          if (useBulkPath) {
            const flowTableDest = (flow as any).tableDestination;
            const bulkEntityLayout = ((flow as any).entityLayouts || []).find(
              (l: any) =>
                l.entity === entity || l.entity === entity.split(":")[0],
            );
            const bulkPartitioning = bulkEntityLayout?.partitionField
              ? {
                  type: "time" as const,
                  field: bulkEntityLayout.partitionField,
                  granularity: bulkEntityLayout.partitionGranularity || "day",
                  requirePartitionFilter:
                    flowTableDest?.partitioning?.requirePartitionFilter,
                }
              : flowTableDest?.partitioning?.enabled
                ? {
                    type: flowTableDest.partitioning.type || "time",
                    field:
                      flowTableDest.partitioning.type === "ingestion"
                        ? "_syncedAt"
                        : flowTableDest.partitioning.field || "_syncedAt",
                    granularity:
                      flowTableDest.partitioning.granularity || "day",
                    requirePartitionFilter:
                      flowTableDest.partitioning.requirePartitionFilter,
                  }
                : undefined;
            const bulkClustering = bulkEntityLayout?.clusterFields?.length
              ? { fields: bulkEntityLayout.clusterFields }
              : flowTableDest?.clustering?.enabled &&
                  flowTableDest.clustering.fields?.length
                ? { fields: flowTableDest.clustering.fields }
                : undefined;

            const bulkLogger: SyncLogger = {
              log: (level: string, message: string, metadata?: any) => {
                const logData = { flowId, entity, executionId, ...metadata };
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

            bulkSyncOptions = {
              dataSourceId: dataSourceId.toString(),
              destinationId: flow.destinationDatabaseId.toString(),
              destinationDatabaseName: flow.destinationDatabaseName,
              flowId: flowId.toString(),
              workspaceId: flow.workspaceId.toString(),
              syncEngine: (flow as any).syncEngine,
              entity,
              isIncremental: flow.syncMode === "incremental",
              tableDestination: flowTableDest,
              deleteMode: (flow as any).deleteMode,
              entityPartitioning: bulkPartitioning,
              entityClustering: bulkClustering,
              logger: bulkLogger,
            };

            await step.run(`prepare-staging-${safeEntityStepId}`, async () => {
              await touchHeartbeat(executionId);
              void appendExecutionLog(
                "info",
                `Preparing staging table for ${entity} (dropping if exists)`,
                { entity },
              );
              await performPrepareStaging(bulkSyncOptions as any);
            });
          }

          let chunkIndex = 0;
          let completed = false;

          while (!completed) {
            await throwIfExecutionCancelled("connector-before-chunk", {
              entity,
              chunkIndex,
            });
            const chunkResult = await step.run(
              `sync-${entity}-chunk-${chunkIndex}`,
              async () => {
                logger.info("Executing chunk", {
                  flowId,
                  entity,
                  chunkIndex,
                });

                // Create sync logger wrapper
                const syncLogger: SyncLogger = {
                  log: (level: string, message: string, metadata?: any) => {
                    const logData = {
                      flowId,
                      entity,
                      chunkIndex,
                      executionId, // Include executionId for database sink
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
                    // Log to execution logger is handled by LogTape database sink
                    // No need to manually log here
                  },
                };

                // Resolve per-entity layout from entityLayouts
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
                        ? {
                            enabled: true,
                            fields: entityLayout.clusterFields,
                          }
                        : undefined,
                    };
                  }
                }

                const result = await performSyncChunk({
                  dataSourceId: dataSourceId.toString(),
                  destinationId: flow.destinationDatabaseId.toString(),
                  destinationDatabaseName: flow.destinationDatabaseName,
                  flowId: flowId.toString(),
                  workspaceId: flow.workspaceId.toString(),
                  syncEngine: (flow as any).syncEngine,
                  backfillRunId: backfill
                    ? cdcBackfillRunId || executionId
                    : undefined,
                  entity,
                  isIncremental: flow.syncMode === "incremental",
                  state,
                  maxIterations: 10,
                  logger: syncLogger,
                  step,
                  queries: (flow as any).queries,
                  tableDestination: resolvedTableDest,
                  deleteMode: (flow as any).deleteMode,
                });

                // Track per-entity progress — use $set with dot-path so
                // each entity writes independently (survives Inngest step replay)
                // Keep in-memory aggregate so we can expose global recordsProcessed in UI.
                const totalWrittenForEntity = Number.isFinite(
                  result.totalWritten,
                )
                  ? result.totalWritten
                  : result.state.totalProcessed;
                const totalFetchedForEntity = Number.isFinite(
                  result.totalFetched,
                )
                  ? result.totalFetched
                  : result.state.totalProcessed;
                entityStatsMap[entity] = totalWrittenForEntity;

                if (executionId) {
                  try {
                    const db = Flow.db;
                    const collection = db.collection("flow_executions");
                    const totalProcessedAcrossEntities = Object.values(
                      entityStatsMap,
                    ).reduce((sum, value) => sum + value, 0);
                    await collection.updateOne(
                      { _id: new Types.ObjectId(executionId) },
                      {
                        $set: {
                          lastHeartbeat: new Date(),
                          "stats.recordsProcessed":
                            totalProcessedAcrossEntities,
                          "stats.currentEntity": entity,
                          [`stats.entityStatus.${entity}`]: result.completed
                            ? "completed"
                            : "syncing",
                          [`stats.entityStats.${entity}`]:
                            totalWrittenForEntity,
                        },
                        ...(result.completed
                          ? {
                              $addToSet: {
                                "stats.syncedEntities": entity,
                              },
                            }
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
                      } as any,
                    );
                  } catch (error) {
                    logger.warn("Failed to update heartbeat", {
                      executionId,
                      error:
                        error instanceof Error ? error.message : String(error),
                    });
                  }
                }

                logger.info("Chunk completed", {
                  flowId,
                  entity,
                  chunkIndex,
                  totalProcessed: totalWrittenForEntity,
                  totalWritten: totalWrittenForEntity,
                  totalFetched: totalFetchedForEntity,
                  hasMore: !result.completed,
                });

                // Log completion message when entity sync is done
                if (result.completed) {
                  logger.info(
                    `✅ ${entity} sync completed (${totalWrittenForEntity} written, ${totalFetchedForEntity} fetched)`,
                    {
                      flowId,
                      entity,
                      chunkIndex,
                      executionId,
                      totalWritten: totalWrittenForEntity,
                      totalFetched: totalFetchedForEntity,
                    },
                  );
                }

                return result;
              },
            );
            await throwIfExecutionCancelled("connector-after-chunk", {
              entity,
              chunkIndex,
            });

            state = chunkResult.state;
            completed = chunkResult.completed;

            if (checkpointEnabled && chunkIndex % 10 === 9) {
              await step.run(
                `save-cdc-backfill-checkpoint-${safeEntityStepId}-${chunkIndex}`,
                async () => {
                  await cdcBackfillCheckpointService.saveEntityCheckpoint({
                    workspaceId: String(flow.workspaceId),
                    flowId: String(flow._id),
                    runId: cdcBackfillRunId!,
                    entity,
                    fetchState: chunkResult.state,
                  });
                },
              );
            }
            chunkIndex++;

            if (useBulkPath && bulkSyncOptions && !completed) {
              const tempCount = await getTempCollectionCount(
                flowId.toString(),
                entity,
              );
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

          if (useBulkPath && bulkSyncOptions) {
            const finalRowsInTemp = await getTempCollectionCount(
              flowId.toString(),
              entity,
            );
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
            }
            logger.info(`Merging ${entity} staging table to live`, {
              flowId,
              entity,
            });
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
            logger.info(`Cleaning up ${entity} staging table`, {
              flowId,
              entity,
            });
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
            logger.info(
              `✅ ${entity} bulk backfill complete (buffer → Parquet → staging → live)`,
              { flowId, entity },
            );

            if (executionId) {
              try {
                const db = Flow.db;
                await db.collection("flow_executions").updateOne(
                  { _id: new Types.ObjectId(executionId) },
                  {
                    $set: {
                      lastHeartbeat: new Date(),
                      [`stats.entityStatus.${entity}`]: "completed",
                    },
                    $addToSet: {
                      "stats.syncedEntities": entity,
                    },
                  },
                );
              } catch {
                // non-critical
              }
            }
          }

          if (checkpointEnabled && state) {
            await step.run(
              `complete-cdc-backfill-checkpoint-${safeEntityStepId}`,
              async () => {
                await cdcBackfillCheckpointService.markEntityCompleted({
                  workspaceId: String(flow.workspaceId),
                  flowId: String(flow._id),
                  runId: cdcBackfillRunId!,
                  entity,
                  fetchState: state,
                });
              },
            );
            checkpointCompletedEntities.add(entity);
          }
        }
      } else {
        // Fall back to non-chunked execution for connectors that don't support it
        await throwIfExecutionCancelled("connector-before-non-chunked-sync");
        await step.run("execute-sync", async () => {
          // For non-chunked sync, we need to get the entities
          const dataSource = await databaseDataSourceManager.getDataSource(
            dataSourceId.toString(),
          );
          if (dataSource) {
            // Inject flow queries into dataSource for GraphQL/PostHog connectors
            // The registry maps connection -> config when creating the connector
            const flowQueries = (flow as any).queries;
            if (flowQueries && flowQueries.length > 0) {
              dataSource.connection = {
                ...dataSource.connection,
                queries: flowQueries,
              };
            }

            const connector =
              await syncConnectorRegistry.getConnector(dataSource);
            if (connector) {
              const availableEntities = connector
                .getAvailableEntities()
                .filter(e => typeof e === "string" && e.trim().length > 0);
              const { entities: configuredEntities, hasExplicitSelection } =
                resolveConfiguredEntities(flow);
              const scopedBackfillEntities =
                requestedBackfillEntities.length > 0
                  ? requestedBackfillEntities
                  : backfill &&
                      flow.backfillState?.scope?.mode === "subset" &&
                      Array.isArray(flow.backfillState.scope.entities)
                    ? flow.backfillState.scope.entities
                    : [];

              if (hasExplicitSelection) {
                const invalidEntities = configuredEntities.filter(
                  e => !availableEntities.includes(e),
                );
                if (invalidEntities.length > 0) {
                  throw new Error(
                    `Invalid entities: ${invalidEntities.join(", ")}. Available: ${availableEntities.join(", ")}`,
                  );
                }

                if (backfill && scopedBackfillEntities.length > 0) {
                  const invalidScope = scopedBackfillEntities.filter(
                    entity => !configuredEntities.includes(entity),
                  );
                  if (invalidScope.length > 0) {
                    throw new Error(
                      `Invalid backfill scope entities: ${invalidScope.join(", ")}. Configured entities: ${configuredEntities.join(", ")}`,
                    );
                  }
                  syncedEntities = scopedBackfillEntities;
                  return;
                }
              }

              if (backfill && scopedBackfillEntities.length > 0) {
                const invalidScope = scopedBackfillEntities.filter(
                  entity => !availableEntities.includes(entity),
                );
                if (invalidScope.length > 0) {
                  throw new Error(
                    `Invalid backfill scope entities: ${invalidScope.join(", ")}. Available entities: ${availableEntities.join(", ")}`,
                  );
                }
                syncedEntities = scopedBackfillEntities;
                return;
              }

              syncedEntities = hasExplicitSelection
                ? configuredEntities
                : availableEntities;
            }
          }
          logger.info("Starting non-chunked sync operation", {
            flowId,
            syncMode: flow.syncMode,
            entitiesToSync: syncedEntities,
          });

          if (syncedEntities.length === 0) {
            logger.info(
              "No enabled entities selected; skipping sync execution",
              {
                flowId,
              },
            );
            return { success: true, skipped: true };
          }

          try {
            // Create a sync logger that wraps Inngest's logger
            const syncLogger: SyncLogger = {
              log: (level: string, message: string, metadata?: any) => {
                const logData = {
                  flowId,
                  executionId, // Include executionId for database sink
                  ...metadata,
                };

                // Call specific logger methods directly to avoid dynamic property access issues
                switch (level) {
                  case "debug":
                    logger.debug(message, logData);
                    break;
                  case "info":
                    logger.info(message, logData);
                    // Track progress is handled by LogTape database sink
                    break;
                  case "warn":
                    logger.warn(message, logData);
                    break;
                  case "error":
                    logger.error(message, logData);
                    break;
                  default:
                    logger.info(message, logData);
                    break;
                }
                // Log to database is handled by LogTape database sink
              },
            };

            await performSync(
              dataSourceId.toString(),
              flow.destinationDatabaseId.toString(),
              flow.destinationDatabaseName,
              syncedEntities,
              flow.syncMode === "incremental",
              syncLogger,
              step, // Pass Inngest step for serverless-friendly retries
              (flow as any).queries, // Pass flow queries for GraphQL/PostHog
            );

            logger.info("Sync operation completed successfully", { flowId });
            return { success: true };
          } catch (error: any) {
            logger.error("Sync operation failed", {
              flowId,
              error: error.message,
              stack: error.stack,
            });
            throw error;
          }
        });
      }

      if (backfill && flow.type === "webhook") {
        const replayResult = await step.run(
          "trigger-webhook-replay",
          async () => {
            await touchHeartbeat(executionId);
            const flowObjectId = new Types.ObjectId(flowId);
            const replayBatchSize = Math.max(
              parseInt(process.env.WEBHOOK_REPLAY_BATCH_SIZE || "1000", 10) ||
                1000,
              100,
            );
            // 0 (default) means unbounded replay in this completion pass.
            const maxReplayEvents = Math.max(
              parseInt(process.env.WEBHOOK_REPLAY_MAX_EVENTS || "0", 10) || 0,
              0,
            );
            const replayCutoff = new Date();

            const routingConn = flow.destinationDatabaseId
              ? await DatabaseConnection.findById(flow.destinationDatabaseId)
                  .select("type")
                  .lean()
              : null;
            const webhookDestinationTypeHint = routingConn?.type;

            const replayFilter: Record<string, unknown> = {
              flowId: flowObjectId,
              applyStatus: "pending",
              receivedAt: { $lte: replayCutoff },
            };
            if (isCdcEnabled) {
              replayFilter.status = "pending";
            }

            const totalPending =
              await WebhookEvent.countDocuments(replayFilter);

            let queued = 0;
            let batches = 0;
            let lastReceivedAt: Date | null = null;
            let lastEventId: string | null = null;

            while (maxReplayEvents === 0 || queued < maxReplayEvents) {
              await throwIfExecutionCancelled("webhook-replay-loop", {
                queued,
                totalPending,
              });
              const cursorClause: Record<string, unknown> =
                lastReceivedAt && lastEventId
                  ? {
                      $or: [
                        { receivedAt: { $gt: lastReceivedAt } },
                        {
                          receivedAt: lastReceivedAt,
                          eventId: { $gt: lastEventId },
                        },
                      ],
                    }
                  : {};

              const pendingBatch = (await WebhookEvent.find({
                ...replayFilter,
                ...cursorClause,
              })
                .sort({ receivedAt: 1, eventId: 1 })
                .limit(replayBatchSize)
                .select({ eventId: 1, receivedAt: 1 })
                .lean()) as Array<{ eventId: string; receivedAt?: Date }>;

              if (pendingBatch.length === 0) {
                break;
              }

              for (const pendingEvent of pendingBatch) {
                if (maxReplayEvents > 0 && queued >= maxReplayEvents) break;
                await enqueueWebhookProcess({
                  flowId,
                  eventId: pendingEvent.eventId,
                  isReplay: true,
                  flow: {
                    syncEngine: flow.syncEngine,
                    destinationDatabaseId: flow.destinationDatabaseId,
                    tableDestination: flow.tableDestination,
                  },
                  destinationTypeHint: webhookDestinationTypeHint,
                });
                queued += 1;
              }

              const tail: { eventId: string; receivedAt?: Date } =
                pendingBatch[pendingBatch.length - 1];
              lastReceivedAt = tail.receivedAt
                ? new Date(tail.receivedAt)
                : lastReceivedAt;
              lastEventId = tail.eventId || lastEventId;
              batches += 1;
            }

            return {
              queued,
              totalPending,
              replayCutoff: replayCutoff.toISOString(),
              batches,
              capped: maxReplayEvents > 0 ? queued >= maxReplayEvents : false,
              maxReplayEvents: maxReplayEvents > 0 ? maxReplayEvents : null,
              remainingEstimate: Math.max(totalPending - queued, 0),
            };
          },
        );

        logger.info("Triggered deferred webhook replay", {
          flowId,
          queued: replayResult.queued,
          totalPending: replayResult.totalPending,
          replayCutoff: replayResult.replayCutoff,
          batches: replayResult.batches,
          capped: replayResult.capped,
          maxReplayEvents: replayResult.maxReplayEvents,
          remainingEstimate: replayResult.remainingEstimate,
        });

        if (!isCdcEnabled) {
          await step.run("disable-webhook-backfill-gate", async () => {
            await Flow.findByIdAndUpdate(flowId, {
              $set: {
                "backfillState.status": "completed",
                "backfillState.completedAt": new Date(),
              },
            });
          });
        }
      }

      if (backfill && flow.type === "webhook" && isCdcEnabled) {
        await step.run("mark-bigquery-cdc-backfill-complete", async () => {
          await markCdcBackfillCompletedForFlow({
            flowId: String(flowId),
            workspaceId: String(flow.workspaceId),
          });
        });
        await step.run("drain-bigquery-cdc-pending-events", async () => {
          await touchHeartbeat(executionId);
          await forceDrainCdcFlow({
            workspaceId: String(flow.workspaceId),
            flowId: String(flowId),
          });
        });
        await step.run("cdc-transition-backfill-complete", async () => {
          await syncMachineService.applyBackfillTransition({
            workspaceId: String(flow.workspaceId),
            flowId: String(flow._id),
            event: {
              type: "COMPLETE",
              reason: "Backfill cursor exhausted",
            },
            context: {
              backfillCursorExhausted: true,
            },
          });
          await syncMachineService.applyStreamTransition({
            workspaceId: String(flow.workspaceId),
            flowId: String(flow._id),
            event: {
              type: "START",
              reason: "Stream activated after backfill",
            },
          });
        });
        await step.run("purge-soft-deletes-after-backfill", async () => {
          await purgeSoftDeletesAfterBackfill({
            workspaceId: String(flow.workspaceId),
            flowId: String(flowId),
          });
        });
        await step.run("finalize-cdc-backfill-run", async () => {
          const now = new Date();
          await Flow.findByIdAndUpdate(flowId, {
            $set: {
              "backfillState.completedAt": now,
              "backfillState.consecutiveFailures": 0,
            },
            $unset: {
              "backfillState.runId": "",
            },
          });
          if (cdcBackfillRunId) {
            await cdcBackfillCheckpointService.clearRun({
              workspaceId: String(flow.workspaceId),
              flowId: String(flow._id),
              runId: cdcBackfillRunId,
            });
          }
        });
      }

      // Update flow success status
      await throwIfExecutionCancelled("connector-before-success-mark");
      await step.run("update-success-status", async () => {
        logger.info("Updating flow success status", { flowId });
        await Flow.findByIdAndUpdate(flowId, {
          lastSuccessAt: new Date(),
          lastError: null,
        });
      });

      // Complete execution logging
      await step.run("complete-execution", async () => {
        logger.info("Completing execution logging", {
          flowId,
          executionId,
        });
        if (executionId) {
          try {
            const db = Flow.db;
            const collection = db.collection("flow_executions");
            const completedAt = new Date();

            // Reclaim executions that were falsely marked "abandoned" by the cleanup
            // cron (stale heartbeat while a step was still running) or "failed" by the
            // error handler on a previous retry attempt that hit the status mismatch.
            const result = await collection.updateOne(
              {
                _id: new Types.ObjectId(executionId),
                status: { $in: ["running", "abandoned", "failed"] },
              },
              {
                $set: {
                  completedAt,
                  lastHeartbeat: completedAt,
                  status: "completed",
                  success: true,
                  stats: {
                    recordsProcessed: Object.values(entityStatsMap).reduce(
                      (sum, value) => sum + value,
                      0,
                    ),
                    recordsCreated: 0,
                    recordsUpdated: 0,
                    recordsDeleted: 0,
                    recordsFailed: 0,
                    syncedEntities: syncedEntities || [],
                    entityStats: entityStatsMap,
                    entityStatus: Object.fromEntries(
                      Object.keys(entityStatsMap).map(entity => [
                        entity,
                        "completed",
                      ]),
                    ),
                  },
                },
              },
            );

            if (result.matchedCount === 0) {
              const current = await collection.findOne(
                { _id: new Types.ObjectId(executionId) },
                { projection: { status: 1 } },
              );
              if (current?.status === "cancelled") {
                logger.info(
                  "Skipping completion update because execution is cancelled",
                  {
                    flowId,
                    executionId,
                  },
                );
                return;
              }
              throw new Error(`Failed to update execution: ${executionId}`);
            }

            // Calculate duration after update
            const execution = await collection.findOne({
              _id: new Types.ObjectId(executionId),
            });
            if (execution && execution.startedAt) {
              const duration =
                completedAt.getTime() - new Date(execution.startedAt).getTime();
              await collection.updateOne(
                { _id: new Types.ObjectId(executionId) },
                { $set: { duration } },
              );

              logger.info("Execution completed successfully", {
                flowId,
                executionId,
                duration,
              });
            }
          } catch (error) {
            logger.error("Failed to complete execution logging", {
              flowId,
              executionId,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error; // Re-throw to ensure the step fails
          }
        } else {
          logger.warn("No execution ID available to complete", {
            flowId,
          });
        }
      });

      return { success: true, message: "Sync completed successfully" };
    } catch (error: any) {
      void appendExecutionLog("error", "Flow execution failed", {
        flowId,
        error: error?.message || String(error),
        errorName: error?.name,
        errorCode: error?.code,
      });

      logger.error("Flow failed", {
        flowId,
        error: error.message,
        errorName: error.name,
        errorCode: error.code,
        stack: error.stack,
      });

      // Check if this is a cancellation from Inngest
      const isCancelled =
        error.name === "InngestFunctionCancelledError" ||
        error.name === "FunctionCancelledError" ||
        error.code === "FUNCTION_CANCELLED" ||
        error.message?.includes("cancelled") ||
        error.message?.includes("canceled") ||
        error.message?.includes("Function cancelled");

      logger.info("Error analysis", {
        flowId,
        errorName: error.name,
        errorCode: error.code,
        errorMessage: error.message,
        isCancelled,
      });

      // Cleanup staging tables on failure (for database source full sync)
      // Note: We intentionally do NOT check dbSyncStagingPrepared here.
      // The flag is only set after step.run returns successfully, but the
      // staging table is created inside step.run (in executeDbSyncChunk).
      // If the first chunk creates the staging table then fails permanently,
      // the flag would remain false and cleanup would be skipped — leaving
      // an orphaned staging table. The cleanup logic below handles the case
      // where no staging table exists (via try/catch), so it's safe to
      // always attempt cleanup for database full syncs.
      if (flowRef?.sourceType === "database" && flowRef?.syncMode === "full") {
        const cleanupFlow = flowRef; // Capture for closure
        await step.run("cleanup-staging-on-failure", async () => {
          try {
            logger.info("Cleaning up staging table after failure", { flowId });

            const sourceConnection = await DatabaseConnection.findById(
              cleanupFlow.databaseSource!.connectionId,
            );

            const destinationWriter = await createDestinationWriter(
              {
                destinationDatabaseId: cleanupFlow.destinationDatabaseId,
                destinationDatabaseName: cleanupFlow.destinationDatabaseName,
                tableDestination: cleanupFlow.tableDestination,
                dataSourceId: cleanupFlow.databaseSource!.connectionId,
              },
              sourceConnection?.name,
            );

            if (!cleanupFlow.tableDestination?.tableName && sourceConnection) {
              (destinationWriter as any).config.collectionName =
                `${sourceConnection.name}_sync`;
            }

            (destinationWriter as any).stagingActive = true;
            await destinationWriter.cleanup();
            logger.info("Staging table cleanup completed", { flowId });
          } catch (cleanupError) {
            logger.error("Failed to cleanup staging table", {
              flowId,
              error:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
            });
          }
        });
      }

      // Complete execution logging in a step to ensure it runs
      await step.run("complete-execution-error", async () => {
        if (executionId) {
          try {
            const db = Flow.db;
            const collection = db.collection("flow_executions");
            const completedAt = new Date();

            // Calculate duration from the document's startedAt
            const execution = await collection.findOne({
              _id: new Types.ObjectId(executionId),
            });
            if (execution) {
              const duration =
                completedAt.getTime() - new Date(execution.startedAt).getTime();

              // Update the execution to failed or cancelled
              await collection.updateOne(
                { _id: new Types.ObjectId(executionId) },
                {
                  $set: {
                    completedAt,
                    lastHeartbeat: completedAt,
                    duration,
                    status: isCancelled ? "cancelled" : "failed",
                    success: false,
                    error: {
                      message: isCancelled
                        ? "Flow execution cancelled by user"
                        : error.message,
                      stack: isCancelled ? undefined : error.stack,
                      code: isCancelled
                        ? "USER_CANCELLED"
                        : (error as any).code,
                    },
                  },
                },
              );
            }

            logger.info("Error execution logging completed", {
              flowId,
              executionId,
              status: isCancelled ? "cancelled" : "failed",
            });
          } catch (completeError) {
            logger.error("Failed to complete error execution logging", {
              flowId,
              executionId,
              originalError: error.message,
              completeError:
                completeError instanceof Error
                  ? completeError.message
                  : String(completeError),
            });
            // Don't re-throw here, we want the original error to propagate
          }
        }
      });

      // Update error status (unless cancelled)
      if (!isCancelled) {
        await Flow.findByIdAndUpdate(flowId, {
          lastError: error.message || "Unknown error",
        });
      }

      // Safety: ensure webhook backfill gate is not left active after failures.
      if (backfill && flowRef?.type === "webhook") {
        const destinationType = flowRef.tableDestination?.connectionId
          ? (
              await DatabaseConnection.findById(
                flowRef.tableDestination.connectionId,
              )
                .select({ type: 1 })
                .lean()
            )?.type
          : undefined;
        const isCdcEnabled =
          (flowRef as IFlow).syncEngine === "cdc" &&
          Boolean((flowRef as IFlow).tableDestination?.connectionId) &&
          hasCdcDestinationAdapter(destinationType);
        if (isCdcEnabled) {
          const safeFlowRef = flowRef as IFlow;

          const wasPausedByUser = await step.run(
            "check-pause-vs-cancel",
            async () => {
              const freshFlow = await Flow.findById(flowId)
                .select("backfillState")
                .lean();
              return (
                isCancelled && freshFlow?.backfillState?.status === "paused"
              );
            },
          );

          if (wasPausedByUser) {
            throw error;
          }

          await step.run("cdc-transition-fail", async () => {
            await syncMachineService.applyBackfillTransition({
              workspaceId: String(safeFlowRef.workspaceId),
              flowId: String(flowId),
              event: {
                type: "FAIL",
                reason: "Backfill execution failed",
                errorCode: (error as any)?.code
                  ? String((error as any).code)
                  : "FLOW_EXECUTION_FAILED",
                errorMessage: error.message,
              },
            });
          });
          await step.run("mark-cdc-backfill-interrupted", async () => {
            const update: Record<string, unknown> = {
              "backfillState.status": "error",
              "backfillState.completedAt": null,
            };
            if (cdcBackfillRunId) {
              update["backfillState.runId"] = cdcBackfillRunId;
            }
            await Flow.findByIdAndUpdate(flowId, {
              $set: update,
              $inc: { "backfillState.consecutiveFailures": 1 },
            });
          });
          await step.run("drain-bigquery-cdc-on-failure", async () => {
            await forceDrainCdcFlow({
              workspaceId: String(safeFlowRef.workspaceId),
              flowId: String(flowId),
            });
          });
          throw error;
        }
        await step.run("disable-webhook-backfill-gate-on-failure", async () => {
          await Flow.findByIdAndUpdate(flowId, {
            $set: {
              "backfillState.status": "error",
              "backfillState.completedAt": new Date(),
            },
          });
        });
      }

      throw error;
    }
  },
);

// Flow scheduler - checks and triggers due flows every 5 minutes
export const flowSchedulerFunction = inngest.createFunction(
  {
    id: "scheduled-flow",
    name: "Run Scheduled Flows",
  },
  { cron: "*/5 * * * *" }, // Run every 5 minutes to check for flows to execute
  async ({ step, logger }) => {
    const scheduleLogger = getSyncLogger("scheduler");

    scheduleLogger.info("Scheduled flow runner triggered", {
      timestamp: new Date().toISOString(),
    });

    // Get all scheduled flows with enabled schedules
    const flows = (await step.run("fetch-enabled-flows", async () => {
      const found = await Flow.find({
        type: "scheduled", // Only get scheduled flows explicitly
        "schedule.enabled": true,
      });
      scheduleLogger.info("Found scheduled flows with enabled schedules", {
        count: found.length,
        // Log flow types for debugging
        flowTypes: found.map(f => ({
          id: f._id.toString(),
          type: f.type,
        })),
      });
      return found.map(f => f.toObject() as IFlow);
    })) as IFlow[];

    const now = new Date();
    const executedFlows: string[] = [];
    let schedulingJitter = 0;

    // Check each flow to see if it should run
    for (const flow of flows) {
      const shouldRun = await step.run(`check-flow-${flow._id}`, async () => {
        try {
          const flowDisplayName = await getFlowDisplayName(flow);
          const flowLogger = getSyncLogger(`scheduler.${flow._id}`);

          // Safety check: skip webhook flows (shouldn't happen with our filter, but just in case)
          if (flow.type === "webhook" || !flow.schedule?.cron) {
            flowLogger.warn(
              "CRITICAL: Non-scheduled flow found in scheduler!",
              {
                flowId: flow._id.toString(),
                flowType: flow.type,
                hasSchedule: !!flow.schedule,
                hasCron: !!flow.schedule?.cron,
                schedule: flow.schedule,
              },
            );
            return false;
          }

          flowLogger.debug("Checking flow", {
            flowId: flow._id.toString(),
            flowName: flowDisplayName,
            cronExpression: flow.schedule.cron,
            timezone: flow.schedule.timezone || "UTC",
            currentTime: now.toISOString(),
          });

          // Convert lastRunAt to Date if needed
          const lastRunDate = flow.lastRunAt ? new Date(flow.lastRunAt) : null;

          flowLogger.debug("Flow last run information", {
            flowId: flow._id.toString(),
            lastRunAt: lastRunDate ? lastRunDate.toISOString() : "Never",
            lastRunAtRaw: flow.lastRunAt,
            lastRunAtType: typeof flow.lastRunAt,
          });

          // Parse cron expression with timezone
          const options = {
            currentDate: now,
            tz: flow.schedule.timezone || "UTC",
          };

          const interval = CronExpressionParser.parse(
            flow.schedule.cron,
            options,
          );
          const nextRun = interval.next().toDate();

          // Try to get previous run time as well
          let prevRun: Date | null = null;
          try {
            const prevInterval = CronExpressionParser.parse(
              flow.schedule.cron,
              options,
            );
            prevRun = prevInterval.prev().toDate();
          } catch {
            // Might fail if there's no previous occurrence
          }

          flowLogger.debug("Flow schedule analysis", {
            flowId: flow._id.toString(),
            nextRun: nextRun.toISOString(),
            previousScheduledRun: prevRun ? prevRun.toISOString() : null,
            nextRunTimestamp: nextRun.getTime(),
            currentTimestamp: now.getTime(),
            timeUntilNextRun: nextRun.getTime() - now.getTime(),
          });

          // Check if the flow should have run since the last execution
          const lastRun = lastRunDate || new Date(0);

          // Check if we missed any scheduled runs
          let missedRun = false;
          if (prevRun && lastRun < prevRun && prevRun <= now) {
            missedRun = true;
            flowLogger.warn("Missed scheduled run", {
              flowId: flow._id.toString(),
              missedRunTime: prevRun.toISOString(),
            });
          }

          // Alternative logic: Check if enough time has passed since last run
          // based on the cron schedule
          let alternativeShouldRun = false;
          if (lastRun.getTime() > 0) {
            // Parse from last run time to see when next run should have been
            const intervalFromLastRun = CronExpressionParser.parse(
              flow.schedule.cron,
              {
                currentDate: lastRun,
                tz: flow.schedule.timezone || "UTC",
              },
            );
            const nextRunFromLastRun = intervalFromLastRun.next().toDate();
            alternativeShouldRun = nextRunFromLastRun <= now;

            flowLogger.debug("Alternative schedule check", {
              flowId: flow._id.toString(),
              nextRunFromLastRun: nextRunFromLastRun.toISOString(),
              shouldHaveRunByNow: alternativeShouldRun,
            });
          }

          // Original logic (likely always false since nextRun is future)
          const shouldExecute = nextRun <= now && lastRun < nextRun;

          flowLogger.debug("Schedule execution decision", {
            flowId: flow._id.toString(),
            nextRunIsInPast: nextRun <= now,
            lastRunBeforeNextRun: lastRun < nextRun,
            shouldExecuteOriginalLogic: shouldExecute,
            shouldExecuteAlternativeLogic: alternativeShouldRun,
            shouldExecuteMissedRun: missedRun,
          });

          // Use the alternative logic instead
          return alternativeShouldRun || missedRun;
        } catch (error) {
          logger.error(`Failed to parse cron expression for flow ${flow._id}`, {
            error,
            flowId: flow._id.toString(),
          });
          return false;
        }
      });

      if (shouldRun) {
        // Add small scheduling jitter (0-5 seconds) between flows to spread out the load
        if (schedulingJitter > 0) {
          await step.sleep(`scheduling-jitter-${flow._id}`, schedulingJitter);
        }

        // Trigger the flow (without noJitter flag, so jitter will be applied)
        await step.sendEvent(`trigger-flow-${flow._id}`, {
          name: "flow.execute",
          data: { flowId: flow._id.toString() },
        });

        const flowDisplayName = await getFlowDisplayName(flow);
        executedFlows.push(flowDisplayName);

        // Increment jitter for next flow (0-5 seconds)
        schedulingJitter = Math.floor(Math.random() * 5000);
      }
    }

    scheduleLogger.info("Scheduled flow runner completed", {
      flowsChecked: flows.length,
      flowsExecuted: executedFlows.length,
      executedFlows: executedFlows,
    });

    return {
      checked: flows.length,
      executed: executedFlows.length,
      flows: executedFlows,
    };
  },
);

// Manual trigger function for immediate execution
export const manualFlowFunction = inngest.createFunction(
  {
    id: "manual-flow",
    name: "Manual Flow Trigger",
  },
  { event: "flow.manual" },
  async ({ event, step }) => {
    const { flowId } = event.data;

    // Trigger the flow with noJitter flag
    await step.sendEvent("trigger-flow", {
      name: "flow.execute",
      data: {
        flowId,
        noJitter: true, // Skip jitter for manual execution
      },
    });

    return { success: true, message: `Triggered flow: ${flowId}` };
  },
);

// Cancel running flow function - updates the database when cancel is requested
export const cancelFlowFunction = inngest.createFunction(
  {
    id: "cancel-flow",
    name: "Cancel Running Flow",
  },
  { event: "flow.cancel" },
  async ({ event, logger }) => {
    const { flowId, executionId } = event.data;

    logger.info("Processing cancel request", {
      flowId,
      executionId,
    });

    // Update the execution status to cancelled
    // Inngest will stop the function between steps, but we need to update the DB
    try {
      const db = Flow.db;
      const collection = db.collection("flow_executions");

      if (executionId) {
        const result = await collection.updateOne(
          {
            _id: new Types.ObjectId(executionId),
            status: "running", // Only update if still running
          },
          {
            $set: {
              completedAt: new Date(),
              lastHeartbeat: new Date(),
              status: "cancelled",
              success: false,
              error: {
                message: "Flow execution cancelled by user",
                code: "USER_CANCELLED",
              },
            },
          },
        );

        logger.info("Database update result", {
          flowId,
          executionId,
          modified: result.modifiedCount,
        });
      }
    } catch (error) {
      logger.error("Failed to update execution status", {
        flowId,
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      success: true,
      message: "Cancel request processed",
    };
  },
);

// Cleanup function for abandoned flows
export const cleanupAbandonedFlowsFunction = inngest.createFunction(
  {
    id: "cleanup-abandoned-flows",
    name: "Cleanup Abandoned Flows",
  },
  { cron: "*/15 * * * *" }, // Run every 15 minutes
  async ({ step, logger }) => {
    const result = await step.run("cleanup-abandoned-flows", async () => {
      const db = Flow.db;
      const now = new Date();
      const heartbeatTimeout = new Date(now.getTime() - 600000); // 10 minutes ago

      const executionsCollection = db.collection("flow_executions");
      const locksCollection = db.collection("flow_execution_locks");

      let abandonedCount = 0;
      let staleLockCount = 0;

      // 1. Find and mark abandoned flow executions
      const abandonedExecutions = await executionsCollection
        .find({
          status: "running",
          $or: [
            { lastHeartbeat: { $lt: heartbeatTimeout } },
            {
              lastHeartbeat: { $exists: false },
              startedAt: { $lt: heartbeatTimeout },
            },
          ],
        })
        .toArray();

      if (abandonedExecutions.length > 0) {
        await executionsCollection.updateMany(
          {
            _id: { $in: abandonedExecutions.map(e => e._id) },
          },
          {
            $set: {
              status: "abandoned",
              completedAt: now,
              error: {
                message:
                  "Flow execution abandoned due to worker crash or timeout",
                code: "WORKER_TIMEOUT",
              },
            },
          },
        );
        abandonedCount = abandonedExecutions.length;

        logger.warn("Marked abandoned flow executions", {
          count: abandonedCount,
          executionIds: abandonedExecutions.map(e => e._id.toString()),
        });

        // Clear stale backfill gates and recover CDC state for flows
        // that no longer have any running execution.
        const abandonedFlowIds = Array.from(
          new Set(
            abandonedExecutions
              .map(e =>
                e.flowId instanceof Types.ObjectId
                  ? e.flowId
                  : new Types.ObjectId(String(e.flowId)),
              )
              .filter(Boolean),
          ),
        );

        if (abandonedFlowIds.length > 0) {
          const stillRunningFlowIds = (await executionsCollection.distinct(
            "flowId",
            {
              flowId: { $in: abandonedFlowIds },
              status: "running",
            },
          )) as Types.ObjectId[];

          const runningSet = new Set(
            stillRunningFlowIds.map(id => id.toString()),
          );
          const staleGateFlowIds = abandonedFlowIds.filter(
            id => !runningSet.has(id.toString()),
          );

          if (staleGateFlowIds.length > 0) {
            const gateResetResult = await Flow.updateMany(
              {
                _id: { $in: staleGateFlowIds },
                "backfillState.status": "running",
              },
              {
                $set: {
                  "backfillState.status": "error",
                },
              },
            );

            logger.warn("Reset stale backfill gates", {
              matched: gateResetResult.matchedCount,
              modified: gateResetResult.modifiedCount,
              flowIds: staleGateFlowIds.map(id => id.toString()),
            });

            // Properly transition CDC backfill state and auto-restart
            const stuckCdcFlows = await Flow.find({
              _id: { $in: staleGateFlowIds },
              syncEngine: "cdc",
              $or: [
                { "backfillState.status": "running" },
                { "backfillState.status": "error" },
              ],
            }).lean();

            const MAX_CONSECUTIVE_FAILURES = 3;

            for (const cdcFlow of stuckCdcFlows) {
              const wId = String(cdcFlow.workspaceId);
              const fId = String(cdcFlow._id);
              const failures = cdcFlow.backfillState?.consecutiveFailures ?? 0;

              try {
                // Transition to error via state machine (writes audit record)
                if (cdcFlow.backfillState?.status === "running") {
                  await syncMachineService.applyBackfillTransition({
                    workspaceId: wId,
                    flowId: fId,
                    event: {
                      type: "FAIL",
                      reason:
                        "Backfill execution abandoned (worker crash or timeout)",
                      errorCode: "WORKER_TIMEOUT",
                    },
                  });
                  await Flow.findByIdAndUpdate(fId, {
                    $inc: { "backfillState.consecutiveFailures": 1 },
                  });
                }

                // Auto-restart if under circuit breaker threshold
                if (failures + 1 < MAX_CONSECUTIVE_FAILURES) {
                  const restartResult = await cdcBackfillService.startBackfill(
                    wId,
                    fId,
                    {
                      reuseExistingRunId: true,
                      reason: `Auto-resumed after worker crash/timeout (attempt ${failures + 1}/${MAX_CONSECUTIVE_FAILURES})`,
                    },
                  );
                  logger.info("Auto-restarted abandoned CDC backfill", {
                    flowId: fId,
                    consecutiveFailures: failures + 1,
                    runId: restartResult.runId,
                    reusedRunId: restartResult.reusedRunId,
                  });
                } else {
                  logger.warn(
                    "CDC backfill exceeded max consecutive failures, skipping auto-restart",
                    {
                      flowId: fId,
                      consecutiveFailures: failures + 1,
                      maxAllowed: MAX_CONSECUTIVE_FAILURES,
                    },
                  );
                }
              } catch (cdcErr) {
                logger.error("Failed to recover abandoned CDC backfill", {
                  flowId: fId,
                  error:
                    cdcErr instanceof Error ? cdcErr.message : String(cdcErr),
                });
              }
            }
          }
        }
      }

      // 2. Clean up stale flow locks
      const heartbeatStaleThreshold = new Date(now.getTime() - 600000); // 10 minutes ago
      const staleLocks = await locksCollection
        .find({
          $or: [
            { expiresAt: { $lt: now } },
            { lastHeartbeat: { $lt: heartbeatStaleThreshold } },
            {
              lastHeartbeat: { $exists: false },
              startedAt: { $lt: heartbeatStaleThreshold },
            },
          ],
        })
        .toArray();

      if (staleLocks.length > 0) {
        await locksCollection.deleteMany({
          _id: { $in: staleLocks.map(lock => lock._id) },
        });
        staleLockCount = staleLocks.length;

        logger.info("Cleaned up stale flow locks", {
          count: staleLockCount,
          lockIds: staleLocks.map(l => l._id.toString()),
        });
      }

      logger.info("Cleanup abandoned flows completed", {
        abandonedExecutions: abandonedCount,
        staleLocks: staleLockCount,
        timestamp: now.toISOString(),
      });

      return {
        abandonedExecutions: abandonedCount,
        staleLocks: staleLockCount,
        timestamp: now,
      };
    });

    return result;
  },
);
