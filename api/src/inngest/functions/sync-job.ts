import { inngest } from "../client";
import {
  SyncJob,
  ISyncJob,
  Connector as DataSource,
  DatabaseConnection,
} from "../../database/workspace-schema";
import {
  performSync,
  performSyncChunk,
  SyncLogger,
} from "../../services/sync-executor.service";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { databaseDataSourceManager } from "../../sync/database-data-source-manager";
import { FetchState } from "../../connectors/base/BaseConnector";
import { Types } from "mongoose";
import * as os from "os";
import { CronExpressionParser } from "cron-parser";
import { getExecutionLogger, getSyncLogger } from "../logging";

// Helper function to get job display name
async function getJobDisplayName(job: ISyncJob): Promise<string> {
  try {
    const [dataSource, database] = await Promise.all([
      DataSource.findById(job.dataSourceId),
      DatabaseConnection.findById(job.destinationDatabaseId),
    ]);

    const sourceName = dataSource?.name || job.dataSourceId.toString();
    const destName = database?.name || job.destinationDatabaseId.toString();

    return `${sourceName} → ${destName}`;
  } catch {
    // Fallback to IDs if lookup fails
    return `${job.dataSourceId} → ${job.destinationDatabaseId}`;
  }
}

// Job execution logging interface
interface JobExecutionLog {
  timestamp: Date;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata?: any;
}

interface JobExecution {
  _id?: Types.ObjectId;
  jobId: Types.ObjectId;
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
  logs: JobExecutionLog[];
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

// Helper class for managing job execution logging
class JobExecutionLogger implements SyncLogger {
  private executionId: Types.ObjectId;
  private startTime: Date;
  private logger;
  private totalRecordsProcessed = 0;
  private syncedEntities: Set<string> = new Set();

  constructor(
    private jobId: Types.ObjectId,
    private workspaceId: Types.ObjectId,
    private context: JobExecution["context"],
  ) {
    this.executionId = new Types.ObjectId();
    this.startTime = new Date();
    // Use LogTape logger with execution-specific category
    // All logs from this logger will automatically be stored in database via the sink
    this.logger = getExecutionLogger(
      jobId.toString(),
      this.executionId.toString(),
    );
  }

  // Getter for execution ID
  getExecutionId(): string {
    return this.executionId.toString();
  }

  async start(): Promise<void> {
    const execution: Partial<JobExecution> = {
      _id: this.executionId,
      jobId: this.jobId,
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
    this.log("info", `Job execution started: ${this.context.syncMode} sync`, {
      syncMode: this.context.syncMode,
      dataSourceId: this.context.dataSourceId.toString(),
      destinationDatabaseId: this.context.destinationDatabaseId.toString(),
    });
  }

  // Check if this execution already exists in the database
  async exists(): Promise<boolean> {
    try {
      const db = SyncJob.db;
      const collection = db.collection("job_executions");
      const existing = await collection.findOne({ _id: this.executionId });
      return !!existing;
    } catch (error) {
      console.error("Failed to check job execution existence:", error);
      return false;
    }
  }

  async updateHeartbeat(): Promise<void> {
    await this.saveExecution({
      lastHeartbeat: new Date(),
    });
  }

  log(level: JobExecutionLog["level"], message: string, metadata?: any): void {
    // Log to LogTape with execution context
    // The database sink will automatically store these logs
    const logData = {
      jobId: this.jobId.toString(),
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
    // Only add positive record counts (handle -1 case from custom_fields)
    if (recordsProcessed > 0) {
      this.totalRecordsProcessed += recordsProcessed;
    }
  }

  async complete(
    success: boolean,
    error?: Error,
    stats?: JobExecution["stats"],
  ): Promise<void> {
    const completedAt = new Date();
    const duration = completedAt.getTime() - this.startTime.getTime();

    // Use tracked stats if not provided
    const finalStats = stats || {
      recordsProcessed: this.totalRecordsProcessed,
      recordsCreated: this.totalRecordsProcessed, // Approximate for now
      recordsUpdated: 0,
      recordsDeleted: 0,
      recordsFailed: 0,
      syncedEntities: Array.from(this.syncedEntities),
    };

    const updates: Partial<JobExecution> = {
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
      `Job execution ${success ? "completed" : "failed"} in ${duration}ms`,
      {
        duration,
        success,
        stats: finalStats,
        ...(error && { error: error.message }),
      },
    );
  }

  private async saveExecution(data: Partial<JobExecution>): Promise<void> {
    try {
      const db = SyncJob.db;
      const collection = db.collection("job_executions");

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

        console.log(`Updating job execution:`, {
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
            console.error(
              `Job execution found with string ID instead of ObjectId: ${this.executionId}`,
            );
          }

          console.error(
            `Failed to update job execution - document not found with _id: ${this.executionId}`,
          );
          throw new Error(
            `Job execution document not found: ${this.executionId}`,
          );
        }

        // Log successful updates for debugging
        if (data.status || data.completedAt) {
          console.log(`Job execution ${this.executionId} updated:`, {
            status: data.status,
            completedAt: data.completedAt,
            success: data.success,
            modifiedCount: result.modifiedCount,
          });
        }
      }
    } catch (error) {
      console.error("Failed to save job execution:", error, {
        executionId: this.executionId.toString(),
        updateData: data,
      });
      // Re-throw the error so it can be handled properly
      throw error;
    }
  }
}

// The sync job function
export const syncJobFunction = inngest.createFunction(
  {
    id: "sync-job",
    name: "Execute Sync Job",
    concurrency: {
      limit: 1, // Only one execution per job at a time
      key: "event.data.jobId", // Prevent duplicate executions of the same job
    },
    retries: 2,
    cancelOn: [
      {
        event: "sync/job.cancel",
        if: "async.data.jobId == event.data.jobId",
      },
    ],
  },
  { event: "sync/job.execute" },
  async ({ event, step, logger }) => {
    const { jobId, noJitter } = event.data;

    logger.info("Sync job function started", {
      jobId,
      eventData: event.data,
    });

    // Initialize execution ID for tracking
    let executionId: string | undefined;

    // Helper to create the execution logger
    const getExecutionLogger = (job: ISyncJob): JobExecutionLogger => {
      const logger = new JobExecutionLogger(
        new Types.ObjectId(jobId),
        new Types.ObjectId(job.workspaceId),
        {
          dataSourceId: new Types.ObjectId(job.dataSourceId),
          destinationDatabaseId: new Types.ObjectId(job.destinationDatabaseId),
          destinationDatabaseName: job.destinationDatabaseName,
          syncMode: job.syncMode === "incremental" ? "incremental" : "full",
          entityFilter: job.entityFilter,
          cronExpression: job.schedule?.cron || "N/A",
          timezone: job.schedule?.timezone || "UTC",
        },
      );
      return logger;
    };

    try {
      // Add jitter to prevent thundering herd - random delay 0-60 seconds
      // Skip jitter if noJitter flag is set
      const jitterMs = await step.run("apply-jitter", async () => {
        if (noJitter) {
          logger.info("Skipping jitter", {
            jobId,
          });
          return 0;
        }

        const jitter = Math.floor(Math.random() * 60000);
        logger.info("Executing job with jitter", {
          jobId,
          jitterMs: jitter,
        });

        if (jitter > 0) {
          await new Promise(resolve => setTimeout(resolve, jitter));
        }

        return jitter;
      });

      // Get job details
      const job = (await step.run("fetch-job", async () => {
        const syncJob = await SyncJob.findById(jobId);
        if (!syncJob) {
          throw new Error(`Job ${jobId} not found`);
        }
        return syncJob.toObject() as ISyncJob;
      })) as ISyncJob;

      if (!job || !job.enabled) {
        return { success: false, message: "Job is disabled" };
      }

      // Webhook jobs should not be executed by the sync job function
      if (job.type === "webhook") {
        logger.error("CRITICAL: Webhook job reached sync job executor!", {
          jobId,
          jobType: job.type,
          dataSourceId: job.dataSourceId,
          schedule: job.schedule,
          webhookConfig: !!job.webhookConfig,
        });
        return {
          success: false,
          message: "Webhook jobs cannot be executed as sync jobs",
        };
      }

      // Initialize logger and get execution ID
      executionId = await step.run("initialize-logger", async () => {
        const execLogger = getExecutionLogger(job);
        await execLogger.start();

        const jobDisplayName = await getJobDisplayName(job);
        logger.info("Starting job execution", {
          jobId,
          jobDisplayName,
          jitterApplied: jitterMs,
          executionId: execLogger.getExecutionId(),
          triggerType: noJitter ? "manual" : "scheduled",
        });

        return execLogger.getExecutionId();
      });

      // We have the execution ID, no need to store the logger

      // Update job status
      const currentRunCount = await step.run("update-job-status", async () => {
        const result = await SyncJob.findByIdAndUpdate(
          jobId,
          {
            lastRunAt: new Date(),
            $inc: { runCount: 1 },
          },
          { new: true },
        );
        if (result) {
          return result.runCount;
        }
        return job.runCount + 1;
      });

      logger.info("Job run status updated", {
        jobId,
        runCount: currentRunCount,
      });

      // Validate sync configuration
      await step.run("validate-sync-config", async () => {
        logger.info("Validating sync configuration", {
          jobId,
          syncMode: job.syncMode,
          dataSourceId: job.dataSourceId.toString(),
          destinationDatabaseId: job.destinationDatabaseId.toString(),
          entityFilter: job.entityFilter,
        });
        return true;
      });

      // Variable to track entities synced
      let syncedEntities: string[] = [];

      // Check if connector supports chunked execution
      const supportsChunking = await step.run(
        "check-chunking-support",
        async () => {
          const dataSource = await databaseDataSourceManager.getDataSource(
            job.dataSourceId.toString(),
          );
          if (!dataSource) {
            throw new Error(`Data source not found: ${job.dataSourceId}`);
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
            jobId,
            connectorType: dataSource.type,
            supportsChunking: supports,
          });
          return supports;
        },
      );

      if (supportsChunking) {
        // Get entities to sync
        const entitiesToSync = await step.run(
          "get-entities-to-sync",
          async () => {
            const dataSource = await databaseDataSourceManager.getDataSource(
              job.dataSourceId.toString(),
            );
            if (!dataSource) {
              throw new Error(`Data source not found: ${job.dataSourceId}`);
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

            if (job.entityFilter && job.entityFilter.length > 0) {
              // Validate requested entities
              const invalidEntities = job.entityFilter.filter(
                e => !availableEntities.includes(e),
              );
              if (invalidEntities.length > 0) {
                throw new Error(
                  `Invalid entities: ${invalidEntities.join(", ")}. Available: ${availableEntities.join(", ")}`,
                );
              }
              // Also filter requested list against non-empty names
              return job.entityFilter.filter(
                e => typeof e === "string" && e.trim().length > 0,
              );
            } else {
              return availableEntities;
            }
          },
        );

        // Track the entities we're syncing
        syncedEntities = entitiesToSync;

        // Process each entity with chunked execution
        for (const entity of entitiesToSync) {
          logger.info("Starting chunked sync for entity", {
            jobId,
            entity,
          });

          let state: FetchState | undefined;
          let chunkIndex = 0;
          let completed = false;

          while (!completed) {
            const chunkResult = await step.run(
              `sync-${entity}-chunk-${chunkIndex}`,
              async () => {
                logger.info("Executing chunk", {
                  jobId,
                  entity,
                  chunkIndex,
                });

                // Create sync logger wrapper
                const syncLogger: SyncLogger = {
                  log: (level: string, message: string, metadata?: any) => {
                    const logData = {
                      jobId,
                      entity,
                      chunkIndex,
                      executionId, // Include executionId for database sink
                      ...metadata,
                    };

                    switch (level) {
                      case "debug":
                        logger.debug(message, logData);
                        break;
                      case "info":
                        logger.info(message, logData);
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
                    // Log to execution logger is handled by LogTape database sink
                    // No need to manually log here
                  },
                };

                const result = await performSyncChunk({
                  dataSourceId: job.dataSourceId.toString(),
                  destinationId: job.destinationDatabaseId.toString(),
                  destinationDatabaseName: job.destinationDatabaseName,
                  entity,
                  isIncremental: job.syncMode === "incremental",
                  state,
                  maxIterations: 10, // Run 10 API calls per chunk
                  logger: syncLogger,
                  step, // Pass Inngest step for serverless-friendly retries
                  queries: (job as any).queries, // Pass transfer queries for GraphQL/PostHog
                });

                // Update heartbeat after chunk completes (not during)
                if (executionId) {
                  try {
                    const db = SyncJob.db;
                    const collection = db.collection("job_executions");
                    await collection.updateOne(
                      { _id: new Types.ObjectId(executionId) },
                      { $set: { lastHeartbeat: new Date() } },
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
                  jobId,
                  entity,
                  chunkIndex,
                  totalProcessed: result.state.totalProcessed,
                  hasMore: !result.completed,
                });

                // Log completion message when entity sync is done
                if (result.completed) {
                  logger.info(
                    `✅ ${entity} sync completed (${result.state.totalProcessed} records)`,
                    {
                      jobId,
                      entity,
                      chunkIndex,
                      executionId,
                    },
                  );
                }

                return result;
              },
            );

            state = chunkResult.state;
            completed = chunkResult.completed;
            chunkIndex++;

            if (chunkIndex > 1000) {
              // Safety limit to prevent infinite loops
              throw new Error(
                `Too many chunks (${chunkIndex}) for entity ${entity}. Possible infinite loop.`,
              );
            }
          }

          logger.info("Completed chunked sync for entity", {
            jobId,
            entity,
            totalChunks: chunkIndex,
          });
        }
      } else {
        // Fall back to non-chunked execution for connectors that don't support it
        await step.run("execute-sync", async () => {
          // For non-chunked sync, we need to get the entities
          const dataSource = await databaseDataSourceManager.getDataSource(
            job.dataSourceId.toString(),
          );
          if (dataSource) {
            const connector =
              await syncConnectorRegistry.getConnector(dataSource);
            if (connector) {
              syncedEntities =
                job.entityFilter && job.entityFilter.length > 0
                  ? job.entityFilter
                  : connector.getAvailableEntities();
            }
          }
          logger.info("Starting non-chunked sync operation", {
            jobId,
            syncMode: job.syncMode,
          });

          try {
            // Create a sync logger that wraps Inngest's logger
            const syncLogger: SyncLogger = {
              log: (level: string, message: string, metadata?: any) => {
                const logData = {
                  jobId,
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
              job.dataSourceId.toString(),
              job.destinationDatabaseId.toString(),
              job.destinationDatabaseName,
              job.entityFilter,
              job.syncMode === "incremental",
              syncLogger,
              step, // Pass Inngest step for serverless-friendly retries
              (job as any).queries, // Pass transfer queries for GraphQL/PostHog
            );

            logger.info("Sync operation completed successfully", { jobId });
            return { success: true };
          } catch (error: any) {
            logger.error("Sync operation failed", {
              jobId,
              error: error.message,
              stack: error.stack,
            });
            throw error;
          }
        });
      }

      // Update job success status
      await step.run("update-success-status", async () => {
        logger.info("Updating job success status", { jobId });
        await SyncJob.findByIdAndUpdate(jobId, {
          lastSuccessAt: new Date(),
          lastError: null,
        });
      });

      // Complete execution logging
      await step.run("complete-execution", async () => {
        logger.info("Completing execution logging", {
          jobId,
          executionId,
        });
        if (executionId) {
          try {
            const db = SyncJob.db;
            const collection = db.collection("job_executions");
            const completedAt = new Date();

            // Update the execution to completed
            const result = await collection.updateOne(
              { _id: new Types.ObjectId(executionId) },
              {
                $set: {
                  completedAt,
                  lastHeartbeat: completedAt,
                  status: "completed",
                  success: true,
                  stats: {
                    recordsProcessed: 0, // This would need to be calculated from chunks
                    recordsCreated: 0,
                    recordsUpdated: 0,
                    recordsDeleted: 0,
                    recordsFailed: 0,
                    syncedEntities: syncedEntities || [],
                  },
                },
              },
            );

            if (result.matchedCount === 0) {
              throw new Error(
                `Failed to update execution to completed: ${executionId}`,
              );
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
                jobId,
                executionId,
                duration,
              });
            }
          } catch (error) {
            logger.error("Failed to complete execution logging", {
              jobId,
              executionId,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error; // Re-throw to ensure the step fails
          }
        } else {
          logger.warn("No execution ID available to complete", {
            jobId,
          });
        }
      });

      return { success: true, message: "Sync completed successfully" };
    } catch (error: any) {
      logger.error("Job failed", {
        jobId,
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
        jobId,
        errorName: error.name,
        errorCode: error.code,
        errorMessage: error.message,
        isCancelled,
      });

      // Complete execution logging in a step to ensure it runs
      await step.run("complete-execution-error", async () => {
        if (executionId) {
          try {
            const db = SyncJob.db;
            const collection = db.collection("job_executions");
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
                        ? "Job execution cancelled by user"
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
              jobId,
              executionId,
              status: isCancelled ? "cancelled" : "failed",
            });
          } catch (completeError) {
            logger.error("Failed to complete error execution logging", {
              jobId,
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
        await SyncJob.findByIdAndUpdate(jobId, {
          lastError: error.message || "Unknown error",
        });
      }

      throw error;
    }
  },
);

// Scheduled job runner function
export const scheduledSyncJobFunction = inngest.createFunction(
  {
    id: "scheduled-sync-job",
    name: "Run Scheduled Transfers",
  },
  { cron: "*/5 * * * *" }, // Run every 5 minutes to check for jobs to execute
  async ({ step, logger }) => {
    const scheduleLogger = getSyncLogger("scheduler");

    scheduleLogger.info("Scheduled sync job runner triggered", {
      timestamp: new Date().toISOString(),
    });

    // Get all enabled scheduled sync jobs (not webhooks)
    const jobs = (await step.run("fetch-enabled-jobs", async () => {
      const syncJobs = await SyncJob.find({
        enabled: true,
        type: "scheduled", // Only get scheduled jobs explicitly
      });
      scheduleLogger.info("Found enabled scheduled sync jobs", {
        count: syncJobs.length,
        // Log job types for debugging
        jobTypes: syncJobs.map(job => ({
          id: job._id.toString(),
          type: job.type,
        })),
      });
      return syncJobs.map(job => job.toObject() as ISyncJob);
    })) as ISyncJob[];

    const now = new Date();
    const executedJobs: string[] = [];
    let schedulingJitter = 0;

    // Check each job to see if it should run
    for (const job of jobs) {
      const shouldRun = await step.run(`check-job-${job._id}`, async () => {
        try {
          const jobDisplayName = await getJobDisplayName(job);
          const jobLogger = getSyncLogger(`scheduler.${job._id}`);

          // Safety check: skip webhook jobs (shouldn't happen with our filter, but just in case)
          if (job.type === "webhook" || !job.schedule?.cron) {
            jobLogger.warn("CRITICAL: Non-scheduled job found in scheduler!", {
              jobId: job._id.toString(),
              jobType: job.type,
              hasSchedule: !!job.schedule,
              hasCron: !!job.schedule?.cron,
              schedule: job.schedule,
            });
            return false;
          }

          jobLogger.debug("Checking job", {
            jobId: job._id.toString(),
            jobName: jobDisplayName,
            cronExpression: job.schedule.cron,
            timezone: job.schedule.timezone || "UTC",
            currentTime: now.toISOString(),
          });

          // Convert lastRunAt to Date if needed
          const lastRunDate = job.lastRunAt ? new Date(job.lastRunAt) : null;

          jobLogger.debug("Job last run information", {
            jobId: job._id.toString(),
            lastRunAt: lastRunDate ? lastRunDate.toISOString() : "Never",
            lastRunAtRaw: job.lastRunAt,
            lastRunAtType: typeof job.lastRunAt,
          });

          // Parse cron expression with timezone
          const options = {
            currentDate: now,
            tz: job.schedule.timezone || "UTC",
          };

          const interval = CronExpressionParser.parse(
            job.schedule.cron,
            options,
          );
          const nextRun = interval.next().toDate();

          // Try to get previous run time as well
          let prevRun: Date | null = null;
          try {
            const prevInterval = CronExpressionParser.parse(
              job.schedule.cron,
              options,
            );
            prevRun = prevInterval.prev().toDate();
          } catch {
            // Might fail if there's no previous occurrence
          }

          jobLogger.debug("Job schedule analysis", {
            jobId: job._id.toString(),
            nextRun: nextRun.toISOString(),
            previousScheduledRun: prevRun ? prevRun.toISOString() : null,
            nextRunTimestamp: nextRun.getTime(),
            currentTimestamp: now.getTime(),
            timeUntilNextRun: nextRun.getTime() - now.getTime(),
          });

          // Check if the job should have run since the last execution
          const lastRun = lastRunDate || new Date(0);

          // Check if we missed any scheduled runs
          let missedRun = false;
          if (prevRun && lastRun < prevRun && prevRun <= now) {
            missedRun = true;
            jobLogger.warn("Missed scheduled run", {
              jobId: job._id.toString(),
              missedRunTime: prevRun.toISOString(),
            });
          }

          // Alternative logic: Check if enough time has passed since last run
          // based on the cron schedule
          let alternativeShouldRun = false;
          if (lastRun.getTime() > 0) {
            // Parse from last run time to see when next run should have been
            const intervalFromLastRun = CronExpressionParser.parse(
              job.schedule.cron,
              {
                currentDate: lastRun,
                tz: job.schedule.timezone || "UTC",
              },
            );
            const nextRunFromLastRun = intervalFromLastRun.next().toDate();
            alternativeShouldRun = nextRunFromLastRun <= now;

            jobLogger.debug("Alternative schedule check", {
              jobId: job._id.toString(),
              nextRunFromLastRun: nextRunFromLastRun.toISOString(),
              shouldHaveRunByNow: alternativeShouldRun,
            });
          }

          // Original logic (likely always false since nextRun is future)
          const shouldExecute = nextRun <= now && lastRun < nextRun;

          jobLogger.debug("Schedule execution decision", {
            jobId: job._id.toString(),
            nextRunIsInPast: nextRun <= now,
            lastRunBeforeNextRun: lastRun < nextRun,
            shouldExecuteOriginalLogic: shouldExecute,
            shouldExecuteAlternativeLogic: alternativeShouldRun,
            shouldExecuteMissedRun: missedRun,
          });

          // Use the alternative logic instead
          return alternativeShouldRun || missedRun;
        } catch (error) {
          logger.error(`Failed to parse cron expression for job ${job._id}`, {
            error,
            jobId: job._id.toString(),
          });
          return false;
        }
      });

      if (shouldRun) {
        // Add small scheduling jitter (0-5 seconds) between jobs to spread out the load
        if (schedulingJitter > 0) {
          await step.sleep(`scheduling-jitter-${job._id}`, schedulingJitter);
        }

        // Trigger the sync job (without noJitter flag, so jitter will be applied)
        await step.sendEvent(`trigger-job-${job._id}`, {
          name: "sync/job.execute",
          data: { jobId: job._id.toString() },
        });

        const jobDisplayName = await getJobDisplayName(job);
        executedJobs.push(jobDisplayName);

        // Increment jitter for next job (0-5 seconds)
        schedulingJitter = Math.floor(Math.random() * 5000);
      }
    }

    scheduleLogger.info("Scheduled job runner completed", {
      jobsChecked: jobs.length,
      jobsExecuted: executedJobs.length,
      executedJobs: executedJobs,
    });

    return {
      checked: jobs.length,
      executed: executedJobs.length,
      jobs: executedJobs,
    };
  },
);

// Manual trigger function for immediate execution
export const manualSyncJobFunction = inngest.createFunction(
  {
    id: "manual-sync-job",
    name: "Manual Sync Job Trigger",
  },
  { event: "sync/job.manual" },
  async ({ event, step }) => {
    const { jobId } = event.data;

    // Trigger the sync job with noJitter flag
    await step.sendEvent("trigger-sync-job", {
      name: "sync/job.execute",
      data: {
        jobId,
        noJitter: true, // Skip jitter for manual execution
      },
    });

    return { success: true, message: `Triggered sync job: ${jobId}` };
  },
);

// Cancel running job function - updates the database when cancel is requested
export const cancelSyncJobFunction = inngest.createFunction(
  {
    id: "cancel-sync-job",
    name: "Cancel Running Sync Job",
  },
  { event: "sync/job.cancel" },
  async ({ event, logger }) => {
    const { jobId, executionId } = event.data;

    logger.info("Processing cancel request", {
      jobId,
      executionId,
    });

    // Update the execution status to cancelled
    // Inngest will stop the function between steps, but we need to update the DB
    try {
      const db = SyncJob.db;
      const collection = db.collection("job_executions");

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
                message: "Job execution cancelled by user",
                code: "USER_CANCELLED",
              },
            },
          },
        );

        logger.info("Database update result", {
          jobId,
          executionId,
          modified: result.modifiedCount,
        });
      }
    } catch (error) {
      logger.error("Failed to update execution status", {
        jobId,
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

// Cleanup function for abandoned jobs
export const cleanupAbandonedJobsFunction = inngest.createFunction(
  {
    id: "cleanup-abandoned-jobs",
    name: "Cleanup Abandoned Jobs",
  },
  { cron: "*/15 * * * *" }, // Run every 15 minutes
  async ({ step, logger }) => {
    const result = await step.run("cleanup-abandoned-jobs", async () => {
      const db = SyncJob.db;
      const now = new Date();
      const heartbeatTimeout = new Date(now.getTime() - 120000); // 2 minutes ago

      const executionsCollection = db.collection("job_executions");
      const locksCollection = db.collection("job_execution_locks");

      let abandonedCount = 0;
      let staleLockCount = 0;

      // 1. Find and mark abandoned job executions
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
                  "Job execution abandoned due to worker crash or timeout",
                code: "WORKER_TIMEOUT",
              },
            },
          },
        );
        abandonedCount = abandonedExecutions.length;

        logger.warn("Marked abandoned job executions", {
          count: abandonedCount,
          executionIds: abandonedExecutions.map(e => e._id.toString()),
        });
      }

      // 2. Clean up stale job locks
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

        logger.info("Cleaned up stale job locks", {
          count: staleLockCount,
          lockIds: staleLocks.map(l => l._id.toString()),
        });
      }

      logger.info("Cleanup abandoned jobs completed", {
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
