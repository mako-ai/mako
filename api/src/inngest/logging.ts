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

        // Append log to execution document (limit to last 1000 entries to prevent
        // hitting MongoDB's 16MB document size limit for long-running executions)
        await collection.updateOne({ _id: new Types.ObjectId(executionId) }, {
          $push: { logs: { $each: [logEntry], $slice: -1000 } },
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

/**
 * Extracts a readable error message from various error types.
 * Handles Error objects, plain objects with message/error properties, and strings.
 */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "object" && err !== null) {
    // Check for common error-like properties
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") {
      return obj.message;
    }
    if (typeof obj.error === "string") {
      return obj.error;
    }
    // Try to stringify, but avoid [object Object]
    try {
      const str = JSON.stringify(err);
      // Truncate very long strings
      return str.length > 500 ? str.slice(0, 500) + "..." : str;
    } catch {
      return "Unknown error (unstringifiable object)";
    }
  }
  return String(err);
}

/**
 * Extracts structured error properties for logging context.
 */
function extractErrorProperties(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessage: err.message,
      errorStack: err.stack?.split("\n").slice(0, 5).join("\n"),
      ...(err as Error & Record<string, unknown>), // Include any custom properties
    };
  }
  if (typeof err === "object" && err !== null) {
    return { errorDetails: err };
  }
  return { errorValue: err };
}

// Create a LogTape logger wrapper that implements Inngest's logger interface
export class LogTapeInngestLogger {
  private logger;
  private _bindings: Record<string, unknown> = {};

  constructor(category: string[] = ["inngest"]) {
    this.logger = getLogger(category);
  }

  info(msg: string, ...args: any[]): void {
    const { message, props } = this.normalizeLogArgs(msg, args);
    this.logger.info(message, props);
  }

  warn(msg: string, ...args: any[]): void {
    const { message, props } = this.normalizeLogArgs(msg, args);
    this.logger.warn(message, props);
  }

  error(msg: string, ...args: any[]): void {
    const { message, props } = this.normalizeLogArgs(msg, args, true);
    this.logger.error(message, props);
  }

  debug(msg: string, ...args: any[]): void {
    const { message, props } = this.normalizeLogArgs(msg, args);
    this.logger.debug(message, props);
  }

  // Support child logger creation for Inngest
  child(bindings: Record<string, unknown>): LogTapeInngestLogger {
    const childLogger = new LogTapeInngestLogger([...this.logger.category]);
    childLogger._bindings = { ...this._bindings, ...bindings };
    return childLogger;
  }

  /**
   * Normalizes log arguments to handle various calling patterns:
   * - logger.error("message", { props })
   * - logger.error(errorObject)
   * - logger.error({ error: "something" })
   */
  private normalizeLogArgs(
    msg: unknown,
    args: unknown[],
    isError = false,
  ): { message: string; props: Record<string, unknown> } {
    // Start with bindings
    const props: Record<string, unknown> = { ...this._bindings };

    // Case 1: First argument is an Error object
    if (msg instanceof Error) {
      Object.assign(props, extractErrorProperties(msg));
      // Merge any additional args
      if (args.length > 0 && typeof args[0] === "object" && args[0] !== null) {
        Object.assign(props, args[0]);
      }
      return { message: msg.message, props };
    }

    // Case 2: First argument is an object (not a string)
    if (typeof msg === "object" && msg !== null) {
      const message = extractErrorMessage(msg);
      if (isError) {
        Object.assign(props, extractErrorProperties(msg));
      } else {
        Object.assign(props, msg as Record<string, unknown>);
      }
      // Merge any additional args
      if (args.length > 0 && typeof args[0] === "object" && args[0] !== null) {
        Object.assign(props, args[0]);
      }
      return { message, props };
    }

    // Case 3: First argument is a string (normal case)
    const message = typeof msg === "string" ? msg : String(msg);

    // Process additional arguments
    for (const arg of args) {
      if (arg instanceof Error) {
        Object.assign(props, extractErrorProperties(arg));
      } else if (typeof arg === "object" && arg !== null) {
        Object.assign(props, arg);
      }
    }

    return { message, props };
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
