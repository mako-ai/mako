import { getLogger, type Sink, type LogRecord } from "@logtape/logtape";
import { Types } from "mongoose";
import { Flow } from "../database/workspace-schema";

// Database sink for flow execution logs
interface DatabaseSinkOptions {
  // Collection name for storing logs
  collectionName?: string;
  // Filter function to determine which logs to store
  filter?: (record: LogRecord) => boolean;
}

export function getDatabaseSink(options: DatabaseSinkOptions = {}): Sink {
  const {
    collectionName = "flow_executions",
    filter = record => record.category.includes("execution"),
  } = options;

  return (record: LogRecord) => {
    // Only store logs that pass the filter
    if (!filter(record)) {
      return;
    }

    // Extract execution context from the log properties
    const executionId = record.properties?.executionId as string;

    if (!executionId) {
      // Skip logs without execution context
      return;
    }

    // Perform database operation asynchronously without blocking
    void (async () => {
      try {
        const db = Flow.db;
        const collection = db.collection(collectionName);

        // Create log entry
        const logEntry = {
          timestamp: new Date(record.timestamp),
          level: record.level,
          message: record.message.join(" "),
          metadata: {
            ...record.properties,
            category: record.category.join("."),
          },
        };

        // Append log to execution document
        await collection.updateOne({ _id: new Types.ObjectId(executionId) }, {
          $push: { logs: logEntry },
          $set: { lastHeartbeat: new Date() },
        } as any);
      } catch (error) {
        // Don't throw errors from sink to avoid disrupting the application
        console.error("Failed to write log to database:", error);
      }
    })();
  };
}

// Note: LogTape is configured once in api/src/logging/index.ts
// This file provides Inngest-specific logging utilities that work with the global config

// Create a LogTape logger wrapper that implements Inngest's logger interface
export class LogTapeInngestLogger {
  private logger;
  private _bindings: Record<string, unknown> = {};

  constructor(category: string[] = ["inngest"]) {
    this.logger = getLogger(category);
  }

  info(msg: string, ...args: any[]): void {
    this.logger.info(msg, this.parseArgs(args));
  }

  warn(msg: string, ...args: any[]): void {
    this.logger.warn(msg, this.parseArgs(args));
  }

  error(msg: string, ...args: any[]): void {
    this.logger.error(msg, this.parseArgs(args));
  }

  debug(msg: string, ...args: any[]): void {
    this.logger.debug(msg, this.parseArgs(args));
  }

  // Support child logger creation for Inngest
  child(bindings: Record<string, unknown>): LogTapeInngestLogger {
    const childLogger = new LogTapeInngestLogger([...this.logger.category]);
    childLogger._bindings = { ...this._bindings, ...bindings };
    return childLogger;
  }

  private parseArgs(args: any[]): Record<string, unknown> {
    // Merge any existing bindings
    const props: Record<string, unknown> = { ...this._bindings };

    // If first arg is an object, merge it as properties
    if (args.length > 0 && typeof args[0] === "object" && args[0] !== null) {
      Object.assign(props, args[0]);
    } else if (args.length > 0) {
      // Otherwise, add args as an array property
      props.args = args;
    }

    return props;
  }
}

// Export a function to get a logger for a specific category
export function getSyncLogger(entity?: string) {
  const category = entity ? ["inngest", "sync", entity] : ["inngest", "sync"];
  return getLogger(category);
}

// Export a function to get an execution logger
export function getExecutionLogger(flowId: string, executionId: string) {
  return getLogger(["inngest", "execution", flowId, executionId]);
}
