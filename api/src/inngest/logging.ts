import {
  configure,
  getLogger,
  getConsoleSink,
  type Sink,
  type LogRecord,
} from "@logtape/logtape";
import { AsyncLocalStorage } from "node:async_hooks";
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

// Configure LogTape for Inngest functions
export async function configureLogging() {
  await configure({
    contextLocalStorage: new AsyncLocalStorage(),
    sinks: {
      console: getConsoleSink({
        formatter: record => {
          const emojiMap: Record<string, string> = {
            debug: "🔍",
            info: "ℹ️",
            warning: "⚠️",
            error: "❌",
            fatal: "🚨",
          };
          const emoji = emojiMap[record.level] || "📝";

          const timestamp = new Date(record.timestamp).toISOString();
          const level = record.level.toUpperCase().padEnd(7);
          const category = record.category.join(".");

          // Build the base message
          let message = `${emoji} [${timestamp}] ${level} ${category}: ${record.message.join(" ")}`;

          // Add properties if present
          if (record.properties && Object.keys(record.properties).length > 0) {
            const props = JSON.stringify(record.properties, null, 2);
            message += `\n   Properties: ${props}`;
          }

          return message;
        },
      }),
      database: getDatabaseSink({
        // Only store execution logs to database
        filter: record => {
          // Store logs that have executionId in properties or are from execution category
          return (
            record.properties?.executionId !== undefined ||
            record.category.some(cat => cat === "execution")
          );
        },
      }),
    },
    loggers: [
      {
        category: ["inngest"],
        sinks: ["console", "database"], // Add database sink to all Inngest logs
      },
      {
        category: ["inngest", "sync"],
        sinks: ["console", "database"], // Add database sink to sync logs too
      },
      {
        category: ["inngest", "execution"],
        sinks: ["console", "database"], // Execution logs go to both console and database
      },
    ],
  });
}

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
