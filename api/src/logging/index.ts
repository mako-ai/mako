import {
  configure,
  getLogger as getLogTapeLogger,
  type Logger,
  type LogLevel,
} from "@logtape/logtape";
import { getPrettyConsoleSink } from "./sinks/console";
import { getGCloudSink } from "./sinks/gcloud";
import { requestContextStorage } from "./context";

export { loggingMiddleware, enrichContextWithUser, enrichContextWithWorkspace, getRequestContext } from "./context";
export type { RequestContext } from "./context";

/**
 * Detects if running on Google Cloud Run
 * K_SERVICE is automatically set by Cloud Run
 */
export function isCloudRun(): boolean {
  return !!process.env.K_SERVICE;
}

/**
 * Detects if running in production mode
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production" || isCloudRun();
}

/**
 * Minimum log level based on environment
 * - Development: debug (show everything)
 * - Production: info (skip debug)
 */
function getMinLevel(): LogLevel {
  return isProduction() ? "info" : "debug";
}

let configured = false;

/**
 * Initialize the logging system
 * Call this once at application startup, before any logging occurs
 */
export async function initializeLogging(): Promise<void> {
  if (configured) {
    return;
  }

  const minLevel = getMinLevel();
  const sinkName = isCloudRun() ? "gcloud" : "console";

  await configure({
    contextLocalStorage: requestContextStorage,
    sinks: {
      console: getPrettyConsoleSink(),
      gcloud: getGCloudSink(),
    },
    filters: {
      minLevel: (record) => {
        const levels: LogLevel[] = ["debug", "info", "warning", "error", "fatal"];
        return levels.indexOf(record.level) >= levels.indexOf(minLevel);
      },
    },
    loggers: [
      // Root logger - catches everything
      {
        category: [],
        level: minLevel,
        sinks: [sinkName],
      },
      // HTTP request logs
      {
        category: ["http"],
        level: minLevel,
        sinks: [sinkName],
      },
      // Database operations
      {
        category: ["db"],
        level: minLevel,
        sinks: [sinkName],
      },
      // Authentication
      {
        category: ["auth"],
        level: minLevel,
        sinks: [sinkName],
      },
      // Agent/AI operations
      {
        category: ["agent"],
        level: minLevel,
        sinks: [sinkName],
      },
      // Connectors (Stripe, Close, etc.)
      {
        category: ["connector"],
        level: minLevel,
        sinks: [sinkName],
      },
      // Sync operations
      {
        category: ["sync"],
        level: minLevel,
        sinks: [sinkName],
      },
      // Query execution
      {
        category: ["query"],
        level: minLevel,
        sinks: [sinkName],
      },
      // Workspace operations
      {
        category: ["workspace"],
        level: minLevel,
        sinks: [sinkName],
      },
      // Flow/Inngest operations (keep existing inngest logging working)
      {
        category: ["inngest"],
        level: minLevel,
        sinks: [sinkName],
      },
    ],
  });

  configured = true;
}

/**
 * Get a logger for a specific category
 *
 * Categories should be hierarchical, e.g.:
 * - ["http"] - HTTP request logging
 * - ["db", "mongodb"] - MongoDB operations
 * - ["auth", "oauth"] - OAuth authentication
 * - ["connector", "stripe"] - Stripe connector
 * - ["query", "execute"] - Query execution
 *
 * @example
 * const logger = getLogger(["db", "mongodb"]);
 * logger.info("Connected to database", { host: "localhost", db: "myapp" });
 *
 * @example
 * const logger = getLogger(["auth"]);
 * logger.warn("Invalid login attempt", { email: "user@example.com", reason: "bad password" });
 */
export function getLogger(category: string[]): Logger {
  return getLogTapeLogger(category);
}

/**
 * Pre-configured loggers for common use cases
 */
export const loggers = {
  /** HTTP request/response logging */
  http: () => getLogger(["http"]),

  /** Database operations */
  db: (driver?: string) => getLogger(driver ? ["db", driver] : ["db"]),

  /** Authentication */
  auth: (provider?: string) => getLogger(provider ? ["auth", provider] : ["auth"]),

  /** AI agent operations */
  agent: (model?: string) => getLogger(model ? ["agent", model] : ["agent"]),

  /** Data connectors */
  connector: (type?: string) => getLogger(type ? ["connector", type] : ["connector"]),

  /** Sync operations */
  sync: (entity?: string) => getLogger(entity ? ["sync", entity] : ["sync"]),

  /** Query execution */
  query: (type?: string) => getLogger(type ? ["query", type] : ["query"]),

  /** Workspace operations */
  workspace: () => getLogger(["workspace"]),

  /** Inngest/flow operations */
  inngest: (fn?: string) => getLogger(fn ? ["inngest", fn] : ["inngest"]),

  /** Application lifecycle */
  app: () => getLogger(["app"]),

  /** Migrations */
  migration: () => getLogger(["migration"]),
} as const;
