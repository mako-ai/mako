/**
 * The `flow_executions` document a flow run writes: created at start,
 * heartbeated, completed. Log lines go through LogTape's execution logger,
 * whose database sink stores them on the same document.
 */
import { Flow, IFlow } from "../../../database/workspace-schema";
import type { SyncLogger } from "../../../services/sync-executor.service";
import { Types } from "mongoose";
import * as os from "os";
import { getExecutionLogger } from "../../logging";
import { loggers } from "../../../logging";
import { resolveConfiguredEntities } from "../../../sync-cdc/entity-selection";

const flowLogger = loggers.inngest("flow");

// Flow execution logging interface
interface FlowExecutionLog {
  timestamp: Date;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata?: any;
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
export class FlowExecutionLogger implements SyncLogger {
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

/** The execution logger for one run of `flow`, with its run context. */
export function createExecutionLogger(
  flowId: string,
  flow: IFlow,
): FlowExecutionLogger {
  return new FlowExecutionLogger(
    new Types.ObjectId(flowId),
    new Types.ObjectId(flow.workspaceId),
    {
      dataSourceId: flow.dataSourceId
        ? new Types.ObjectId(flow.dataSourceId)
        : flow.databaseSource?.connectionId
          ? new Types.ObjectId(flow.databaseSource.connectionId)
          : new Types.ObjectId(flow.destinationDatabaseId),
      destinationDatabaseId: new Types.ObjectId(flow.destinationDatabaseId),
      destinationDatabaseName: flow.destinationDatabaseName,
      syncMode: flow.syncMode === "incremental" ? "incremental" : "full",
      entityFilter: resolveConfiguredEntities(flow).entities,
      cronExpression: flow.schedule?.cron || "N/A",
      timezone: flow.schedule?.timezone || "UTC",
    },
  );
}
