import { inngest } from "../client";
import {
  DbSync,
  DbSyncExecution,
  DatabaseConnection,
  IDbSync,
  IDbSyncExecution,
  IDatabaseConnection,
} from "../../database/workspace-schema";
import { databaseRegistry } from "../../databases/registry";
import { ColumnDefinition, DatabaseDriver } from "../../databases/driver";
import type { Types } from "mongoose";
import os from "os";

/**
 * Execution logger for db-to-db syncs
 * Stores logs in MongoDB for persistence and debugging
 */
class DbSyncExecutionLogger {
  private executionId: string;
  private logs: IDbSyncExecution["logs"] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private pendingLogs: IDbSyncExecution["logs"] = [];

  constructor(executionId: string) {
    this.executionId = executionId;
    // Auto-flush logs every 5 seconds
    this.flushInterval = setInterval(() => this.flush(), 5000);
  }

  private addLog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    metadata?: any,
  ) {
    const log = {
      timestamp: new Date(),
      level,
      message,
      ...(metadata ? { metadata } : {}),
    };
    this.logs.push(log);
    this.pendingLogs.push(log);

    // Console output for debugging
    const prefix = `[DbSync:${this.executionId.slice(-6)}]`;
    if (level === "error") {
      console.error(`${prefix} ${message}`, metadata || "");
    } else if (level === "warn") {
      console.warn(`${prefix} ${message}`, metadata || "");
    } else {
      console.log(`${prefix} ${message}`, metadata || "");
    }
  }

  debug(message: string, metadata?: any) {
    this.addLog("debug", message, metadata);
  }

  info(message: string, metadata?: any) {
    this.addLog("info", message, metadata);
  }

  warn(message: string, metadata?: any) {
    this.addLog("warn", message, metadata);
  }

  error(message: string, metadata?: any) {
    this.addLog("error", message, metadata);
  }

  async flush() {
    if (this.pendingLogs.length === 0) return;

    try {
      await DbSyncExecution.updateOne(
        { _id: this.executionId },
        {
          $push: { logs: { $each: this.pendingLogs } },
          $set: { lastHeartbeat: new Date() },
        },
      );
      this.pendingLogs = [];
    } catch (err) {
      console.error("Failed to flush logs:", err);
    }
  }

  async close() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flush();
  }

  getLogs() {
    return this.logs;
  }
}

/**
 * Create an execution record for tracking
 */
async function createExecution(
  dbSync: IDbSync,
): Promise<IDbSyncExecution> {
  const execution = await DbSyncExecution.create({
    dbSyncId: dbSync._id,
    workspaceId: dbSync.workspaceId,
    startedAt: new Date(),
    status: "running",
    success: false,
    logs: [],
    context: {
      sourceDatabaseId: dbSync.source.databaseConnectionId,
      targetDatabaseId: dbSync.target.databaseConnectionId,
      syncMode: dbSync.syncMode,
      query: dbSync.source.query,
    },
    system: {
      workerId: `worker-${process.pid}`,
      nodeVersion: process.version,
      hostname: os.hostname(),
    },
  });

  return execution;
}

/**
 * Update execution status
 */
async function updateExecution(
  executionId: string,
  update: Partial<IDbSyncExecution>,
) {
  await DbSyncExecution.updateOne({ _id: executionId }, { $set: update });
}

/**
 * Get the appropriate driver for a database connection
 */
function getDriver(database: IDatabaseConnection): DatabaseDriver {
  const driver = databaseRegistry.getDriver(database.connection.type);
  if (!driver) {
    throw new Error(`No driver found for database type: ${database.connection.type}`);
  }
  return driver;
}

/**
 * Check if driver supports write operations
 */
function assertDriverSupportsWrites(driver: DatabaseDriver, type: string): void {
  if (!driver.supportsWrites?.()) {
    throw new Error(`Database driver '${type}' does not support write operations`);
  }
}

/**
 * Build the source query with incremental filtering if needed
 */
function buildSourceQuery(dbSync: IDbSync): string {
  let query = dbSync.source.query.trim();

  // Remove trailing semicolon for manipulation
  if (query.endsWith(";")) {
    query = query.slice(0, -1);
  }

  // For incremental sync, add WHERE clause
  if (
    dbSync.syncMode === "incremental" &&
    dbSync.incrementalConfig?.trackingColumn &&
    dbSync.incrementalConfig?.lastValue
  ) {
    const { trackingColumn, trackingType, lastValue } = dbSync.incrementalConfig;
    const operator = ">";

    // Format the value based on type
    let formattedValue: string;
    if (trackingType === "timestamp") {
      formattedValue = `'${lastValue}'`;
    } else {
      formattedValue = lastValue;
    }

    // Check if query already has WHERE clause
    const hasWhere = /\bWHERE\b/i.test(query);
    if (hasWhere) {
      query += ` AND "${trackingColumn}" ${operator} ${formattedValue}`;
    } else {
      query += ` WHERE "${trackingColumn}" ${operator} ${formattedValue}`;
    }

    // Add ORDER BY for consistent incremental sync
    if (!/\bORDER\s+BY\b/i.test(query)) {
      query += ` ORDER BY "${trackingColumn}" ASC`;
    }
  }

  return query;
}

/**
 * Main db-to-db sync execution function
 */
export const dbSyncFunction = inngest.createFunction(
  {
    id: "db-sync-execute",
    name: "DB Sync Execute",
    retries: 3,
    onFailure: async ({ event, error }) => {
      const { dbSyncId, executionId } = event.data as {
        dbSyncId: string;
        executionId?: string;
      };

      console.error(`DbSync ${dbSyncId} failed:`, error);

      // Update DbSync status
      await DbSync.updateOne(
        { _id: dbSyncId },
        {
          $set: {
            lastError: error.message,
            lastRunAt: new Date(),
          },
        },
      );

      // Update execution if we have one
      if (executionId) {
        await updateExecution(executionId, {
          status: "failed",
          success: false,
          completedAt: new Date(),
          error: {
            message: error.message,
            stack: error.stack,
          },
        });
      }
    },
  },
  { event: "db-sync/execute" },
  async ({ event, step }) => {
    const { dbSyncId } = event.data as { dbSyncId: string };

    // Step 1: Load configuration and create execution record
    const { dbSync, execution, sourceDb, targetDb, sourceDriver, targetDriver } =
      await step.run("load-config", async () => {
        const dbSync = await DbSync.findById(dbSyncId);
        if (!dbSync) {
          throw new Error(`DbSync not found: ${dbSyncId}`);
        }

        if (!dbSync.enabled) {
          throw new Error(`DbSync is disabled: ${dbSyncId}`);
        }

        // Load source and target databases
        const sourceDb = await DatabaseConnection.findById(
          dbSync.source.databaseConnectionId,
        );
        if (!sourceDb) {
          throw new Error(
            `Source database not found: ${dbSync.source.databaseConnectionId}`,
          );
        }

        const targetDb = await DatabaseConnection.findById(
          dbSync.target.databaseConnectionId,
        );
        if (!targetDb) {
          throw new Error(
            `Target database not found: ${dbSync.target.databaseConnectionId}`,
          );
        }

        // Get drivers
        const sourceDriver = getDriver(sourceDb);
        const targetDriver = getDriver(targetDb);

        // Verify target driver supports writes
        assertDriverSupportsWrites(targetDriver, targetDb.connection.type);

        // Create execution record
        const execution = await createExecution(dbSync);

        // Update DbSync with run time
        await DbSync.updateOne(
          { _id: dbSyncId },
          {
            $set: { lastRunAt: new Date() },
            $inc: { runCount: 1 },
          },
        );

        return {
          dbSync: dbSync.toObject(),
          execution: execution.toObject(),
          sourceDb: sourceDb.toObject(),
          targetDb: targetDb.toObject(),
          sourceDriver: sourceDb.connection.type,
          targetDriver: targetDb.connection.type,
        };
      });

    const logger = new DbSyncExecutionLogger(execution._id.toString());
    const startTime = Date.now();

    try {
      logger.info(`Starting ${dbSync.syncMode} sync: ${dbSync.name}`);
      logger.info(`Source: ${sourceDb.name} (${sourceDriver})`);
      logger.info(`Target: ${targetDb.name}/${dbSync.target.tableName} (${targetDriver})`);

      // Re-get drivers in subsequent steps (since they're not serializable)
      const srcDriver = getDriver(sourceDb as IDatabaseConnection);
      const tgtDriver = getDriver(targetDb as IDatabaseConnection);

      // Step 2: Determine if table exists or needs creation
      const { tableExists, needsCreation } = await step.run(
        "check-target-table",
        async () => {
          if (!tgtDriver.tableExists) {
            logger.warn("Target driver does not support tableExists check, assuming table exists");
            return { tableExists: true, needsCreation: false };
          }

          const exists = await tgtDriver.tableExists(
            targetDb as IDatabaseConnection,
            dbSync.target.tableName,
            { schema: dbSync.target.schema },
          );

          logger.info(`Target table exists: ${exists}`);

          return {
            tableExists: exists,
            needsCreation: !exists && dbSync.target.createIfNotExists,
          };
        },
      );

      // Step 3: For full sync, create staging table (only if table already exists)
      const stagingTableName =
        dbSync.syncMode === "full" && tableExists
          ? `${dbSync.target.tableName}_staging_${Date.now()}`
          : null;

      if (stagingTableName) {
        await step.run("create-staging-table", async () => {
          logger.info(`Creating staging table: ${stagingTableName}`);

          if (!tgtDriver.createStagingTable) {
            throw new Error("Target driver does not support staging tables");
          }

          const result = await tgtDriver.createStagingTable(
            targetDb as IDatabaseConnection,
            dbSync.target.tableName,
            stagingTableName,
            { schema: dbSync.target.schema },
          );

          if (!result.success) {
            throw new Error(`Failed to create staging table: ${result.error}`);
          }

          logger.info("Staging table created successfully");
        });
      }

      // Step 4: Execute streaming sync
      const syncResult = await step.run("execute-sync", async () => {
        const query = buildSourceQuery(dbSync as IDbSync);
        logger.info(`Executing source query: ${query.slice(0, 200)}...`);

        let rowsRead = 0;
        let rowsWritten = 0;
        let batchesProcessed = 0;
        let lastTrackingValue: string | null = null;
        let inferredSchema: ColumnDefinition[] | null = null;

        const targetTableName = stagingTableName || dbSync.target.tableName;
        const batchSize = dbSync.batchSize || 2000;

        // Check if source driver supports streaming
        if (!srcDriver.executeStreamingQuery) {
          // Fallback to regular query with manual batching
          logger.info("Source driver does not support streaming, using fallback");

          let offset = 0;
          let hasMore = true;

          while (hasMore) {
            const paginatedQuery = `${query} LIMIT ${batchSize} OFFSET ${offset}`;
            const result = await srcDriver.executeQuery(
              sourceDb as IDatabaseConnection,
              paginatedQuery,
              { databaseName: dbSync.source.database },
            );

            if (!result.success) {
              throw new Error(`Source query failed: ${result.error}`);
            }

            const rows = result.data || [];
            if (rows.length === 0) {
              hasMore = false;
              break;
            }

            rowsRead += rows.length;

            // Infer schema from first batch if needed
            if (!inferredSchema && rows.length > 0 && needsCreation) {
              inferredSchema = tgtDriver.inferSchema?.(rows) || [];
              if (inferredSchema.length > 0) {
                logger.info(`Inferred schema with ${inferredSchema.length} columns`);

                // Create table
                if (tgtDriver.createTable) {
                  const createResult = await tgtDriver.createTable(
                    targetDb as IDatabaseConnection,
                    targetTableName,
                    inferredSchema,
                    { schema: dbSync.target.schema },
                  );
                  if (!createResult.success) {
                    throw new Error(`Failed to create table: ${createResult.error}`);
                  }
                  logger.info(`Created table: ${targetTableName}`);
                }
              }
            }

            // Write batch to target
            let writeResult;
            if (
              dbSync.syncMode === "incremental" &&
              dbSync.conflictConfig?.keyColumns?.length
            ) {
              // Use upsert for incremental sync
              if (!tgtDriver.upsertBatch) {
                throw new Error("Target driver does not support upsert");
              }
              writeResult = await tgtDriver.upsertBatch(
                targetDb as IDatabaseConnection,
                targetTableName,
                rows,
                dbSync.conflictConfig.keyColumns,
                {
                  schema: dbSync.target.schema,
                  conflictStrategy: dbSync.conflictConfig.strategy === "upsert" ? "update" : dbSync.conflictConfig.strategy,
                },
              );
            } else {
              // Use insert for full sync
              if (!tgtDriver.insertBatch) {
                throw new Error("Target driver does not support batch insert");
              }
              writeResult = await tgtDriver.insertBatch(
                targetDb as IDatabaseConnection,
                targetTableName,
                rows,
                { schema: dbSync.target.schema },
              );
            }

            if (!writeResult.success) {
              throw new Error(`Batch write failed: ${writeResult.error}`);
            }

            rowsWritten += writeResult.rowsWritten;
            batchesProcessed++;

            // Track last value for incremental sync
            if (dbSync.incrementalConfig?.trackingColumn) {
              const lastRow = rows[rows.length - 1];
              const trackingVal = lastRow[dbSync.incrementalConfig.trackingColumn];
              if (trackingVal !== undefined && trackingVal !== null) {
                lastTrackingValue =
                  trackingVal instanceof Date
                    ? trackingVal.toISOString()
                    : String(trackingVal);
              }
            }

            logger.info(
              `Batch ${batchesProcessed}: read ${rows.length}, written ${writeResult.rowsWritten}`,
            );

            offset += rows.length;
            if (rows.length < batchSize) {
              hasMore = false;
            }
          }
        } else {
          // Use streaming query
          let firstBatch = true;

          const streamResult = await srcDriver.executeStreamingQuery(
            sourceDb as IDatabaseConnection,
            query,
            {
              batchSize,
              databaseName: dbSync.source.database,
              onBatch: async (rows) => {
                rowsRead += rows.length;

                // Infer schema from first batch if needed
                if (firstBatch && needsCreation && rows.length > 0) {
                  firstBatch = false;
                  inferredSchema = tgtDriver.inferSchema?.(rows) || [];
                  if (inferredSchema.length > 0) {
                    logger.info(`Inferred schema with ${inferredSchema.length} columns`);

                    // Create table
                    if (tgtDriver.createTable) {
                      const createResult = await tgtDriver.createTable(
                        targetDb as IDatabaseConnection,
                        targetTableName,
                        inferredSchema,
                        { schema: dbSync.target.schema },
                      );
                      if (!createResult.success) {
                        throw new Error(`Failed to create table: ${createResult.error}`);
                      }
                      logger.info(`Created table: ${targetTableName}`);
                    }
                  }
                }

                // Write batch to target
                let writeResult;
                if (
                  dbSync.syncMode === "incremental" &&
                  dbSync.conflictConfig?.keyColumns?.length
                ) {
                  if (!tgtDriver.upsertBatch) {
                    throw new Error("Target driver does not support upsert");
                  }
                  writeResult = await tgtDriver.upsertBatch(
                    targetDb as IDatabaseConnection,
                    targetTableName,
                    rows,
                    dbSync.conflictConfig.keyColumns,
                    {
                      schema: dbSync.target.schema,
                      conflictStrategy: dbSync.conflictConfig.strategy === "upsert" ? "update" : dbSync.conflictConfig.strategy,
                    },
                  );
                } else {
                  if (!tgtDriver.insertBatch) {
                    throw new Error("Target driver does not support batch insert");
                  }
                  writeResult = await tgtDriver.insertBatch(
                    targetDb as IDatabaseConnection,
                    targetTableName,
                    rows,
                    { schema: dbSync.target.schema },
                  );
                }

                if (!writeResult.success) {
                  throw new Error(`Batch write failed: ${writeResult.error}`);
                }

                rowsWritten += writeResult.rowsWritten;
                batchesProcessed++;

                // Track last value for incremental sync
                if (dbSync.incrementalConfig?.trackingColumn) {
                  const lastRow = rows[rows.length - 1];
                  const trackingVal = lastRow[dbSync.incrementalConfig.trackingColumn];
                  if (trackingVal !== undefined && trackingVal !== null) {
                    lastTrackingValue =
                      trackingVal instanceof Date
                        ? trackingVal.toISOString()
                        : String(trackingVal);
                  }
                }

                logger.info(
                  `Batch ${batchesProcessed}: read ${rows.length}, written ${writeResult.rowsWritten}`,
                );
              },
            },
          );

          if (!streamResult.success) {
            throw new Error(`Streaming query failed: ${streamResult.error}`);
          }
        }

        return {
          rowsRead,
          rowsWritten,
          batchesProcessed,
          lastTrackingValue,
        };
      });

      // Step 5: Swap staging table (for full sync)
      if (stagingTableName) {
        await step.run("swap-staging-table", async () => {
          logger.info(`Swapping staging table to main table`);

          if (!tgtDriver.swapStagingTable) {
            throw new Error("Target driver does not support staging table swap");
          }

          const result = await tgtDriver.swapStagingTable(
            targetDb as IDatabaseConnection,
            dbSync.target.tableName,
            stagingTableName,
            { schema: dbSync.target.schema },
          );

          if (!result.success) {
            throw new Error(`Failed to swap staging table: ${result.error}`);
          }

          logger.info("Staging table swapped successfully");
        });
      }

      // Step 6: Update tracking value and completion status
      await step.run("finalize", async () => {
        const duration = Date.now() - startTime;

        // Update incremental tracking value
        if (
          dbSync.syncMode === "incremental" &&
          syncResult.lastTrackingValue &&
          dbSync.incrementalConfig?.trackingColumn
        ) {
          await DbSync.updateOne(
            { _id: dbSyncId },
            {
              $set: {
                "incrementalConfig.lastValue": syncResult.lastTrackingValue,
              },
            },
          );
          logger.info(
            `Updated tracking value: ${syncResult.lastTrackingValue}`,
          );
        }

        // Calculate new average duration
        const currentAvg = dbSync.avgDurationMs || duration;
        const runCount = dbSync.runCount || 1;
        const newAvg = Math.round(
          (currentAvg * (runCount - 1) + duration) / runCount,
        );

        // Update DbSync status
        await DbSync.updateOne(
          { _id: dbSyncId },
          {
            $set: {
              lastSuccessAt: new Date(),
              lastError: null,
              avgDurationMs: newAvg,
            },
          },
        );

        // Update execution
        await updateExecution(execution._id.toString(), {
          status: "completed",
          success: true,
          completedAt: new Date(),
          duration,
          stats: {
            rowsRead: syncResult.rowsRead,
            rowsWritten: syncResult.rowsWritten,
            batchesProcessed: syncResult.batchesProcessed,
          },
        });

        logger.info(
          `Sync completed: ${syncResult.rowsRead} rows read, ${syncResult.rowsWritten} rows written in ${duration}ms`,
        );
      });

      await logger.close();

      return {
        success: true,
        executionId: execution._id.toString(),
        stats: syncResult,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Sync failed: ${errorMessage}`);
      await logger.close();

      // Clean up staging table if it exists
      if (stagingTableName) {
        try {
          const tgtDriver = getDriver(targetDb as IDatabaseConnection);
          if (tgtDriver.dropTable) {
            await tgtDriver.dropTable(
              targetDb as IDatabaseConnection,
              stagingTableName,
              { schema: dbSync.target.schema },
            );
          }
        } catch {
          // Ignore cleanup errors
        }
      }

      throw error;
    }
  },
);

/**
 * Manual trigger for db-to-db sync
 */
export const manualDbSyncFunction = inngest.createFunction(
  {
    id: "db-sync-manual",
    name: "DB Sync Manual Trigger",
  },
  { event: "db-sync/manual" },
  async ({ event, step }) => {
    const { dbSyncId } = event.data as { dbSyncId: string };

    // Verify the sync exists and is valid
    await step.run("validate", async () => {
      const dbSync = await DbSync.findById(dbSyncId);
      if (!dbSync) {
        throw new Error(`DbSync not found: ${dbSyncId}`);
      }

      // Check for recent execution to prevent duplicates
      const recentExecution = await DbSyncExecution.findOne({
        dbSyncId,
        status: "running",
        startedAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) }, // Last 5 minutes
      });

      if (recentExecution) {
        throw new Error(
          `Sync is already running (execution: ${recentExecution._id})`,
        );
      }
    });

    // Trigger the actual sync
    await step.sendEvent("trigger-sync", {
      name: "db-sync/execute",
      data: { dbSyncId },
    });

    return { triggered: true, dbSyncId };
  },
);

/**
 * Scheduler function - checks for due syncs every 5 minutes
 */
export const dbSyncSchedulerFunction = inngest.createFunction(
  {
    id: "db-sync-scheduler",
    name: "DB Sync Scheduler",
  },
  { cron: "*/5 * * * *" }, // Every 5 minutes
  async ({ step }) => {
    const parser = await import("cron-parser");
    const { DateTime } = await import("luxon");

    const now = new Date();
    const triggered: string[] = [];

    // Find all enabled syncs
    const syncs = await step.run("find-due-syncs", async () => {
      const enabledSyncs = await DbSync.find({ enabled: true }).lean();
      return enabledSyncs;
    });

    // Process each sync
    for (const sync of syncs) {
      const shouldRun = await step.run(
        `check-sync-${sync._id}`,
        async () => {
          try {
            const timezone = sync.schedule.timezone || "UTC";

            // Parse cron in the specified timezone
            const interval = parser.parseExpression(sync.schedule.cron, {
              currentDate: now,
              tz: timezone,
            });

            // Get the previous scheduled time
            const prevScheduled = interval.prev().toDate();

            // If lastRunAt is before the previous scheduled time, it's due
            if (!sync.lastRunAt || sync.lastRunAt < prevScheduled) {
              // Check if there's already a running execution
              const runningExecution = await DbSyncExecution.findOne({
                dbSyncId: sync._id,
                status: "running",
              });

              if (runningExecution) {
                console.log(`DbSync ${sync._id} already running, skipping`);
                return false;
              }

              return true;
            }

            return false;
          } catch (error) {
            console.error(`Error checking sync ${sync._id}:`, error);
            return false;
          }
        },
      );

      if (shouldRun) {
        // Add random jitter (0-5 seconds) to spread out execution
        const jitter = Math.floor(Math.random() * 5000);

        await step.sleep(`jitter-${sync._id}`, `${jitter}ms`);

        await step.sendEvent(`trigger-${sync._id}`, {
          name: "db-sync/execute",
          data: { dbSyncId: sync._id.toString() },
        });

        triggered.push(sync._id.toString());
      }
    }

    return {
      checked: syncs.length,
      triggered: triggered.length,
      triggeredIds: triggered,
    };
  },
);

/**
 * Cleanup abandoned executions (heartbeat not updated in 30 minutes)
 */
export const cleanupAbandonedDbSyncsFunction = inngest.createFunction(
  {
    id: "db-sync-cleanup-abandoned",
    name: "DB Sync Cleanup Abandoned",
  },
  { cron: "*/15 * * * *" }, // Every 15 minutes
  async ({ step }) => {
    const abandonedCount = await step.run("cleanup", async () => {
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

      const result = await DbSyncExecution.updateMany(
        {
          status: "running",
          lastHeartbeat: { $lt: thirtyMinutesAgo },
        },
        {
          $set: {
            status: "abandoned",
            completedAt: new Date(),
            error: {
              message: "Execution abandoned - no heartbeat for 30 minutes",
            },
          },
        },
      );

      return result.modifiedCount;
    });

    if (abandonedCount > 0) {
      console.log(`Marked ${abandonedCount} db sync executions as abandoned`);
    }

    return { abandonedCount };
  },
);
