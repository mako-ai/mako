import { AsyncLocalStorage } from "node:async_hooks";
import {
  configure,
  getLogger as getLogTapeLogger,
  type Logger,
  type LogLevel,
} from "@logtape/logtape";
import { getPrettyConsoleSink } from "./sinks/console";
import { getJsonSink } from "./sinks/json";
import { getDatabaseSink } from "../inngest/logging";

export {
  loggingMiddleware,
  enrichContextWithUser,
  enrichContextWithWorkspace,
  getRequestContext,
} from "./context";
export type { RequestContext, HttpLoggingOptions } from "./context";

/**
 * Detects if running in production mode
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
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
let initializationPromise: Promise<void> | null = null;

/**
 * Internal function to perform LogTape configuration
 */
async function doInitialize(): Promise<void> {
  if (configured) {
    return;
  }

  const minLevel = getMinLevel();
  // Use pretty console in development, structured JSON in production
  const sinkName = isProduction() ? "json" : "console";

  await configure({
    contextLocalStorage: new AsyncLocalStorage(),
    sinks: {
      console: getPrettyConsoleSink(),
      json: getJsonSink(),
      // Database sink for flow execution logs - stores logs to MongoDB
      database: getDatabaseSink({
        collectionName: "flow_executions",
        filter: record => record.category.includes("execution"),
      }),
    },
    filters: {
      minLevel: record => {
        const levels: LogLevel[] = [
          "debug",
          "info",
          "warning",
          "error",
          "fatal",
        ];
        return levels.indexOf(record.level) >= levels.indexOf(minLevel);
      },
    },
    loggers: [
      // Note: No root logger - specific categories only to avoid duplicate logs
      // HTTP request logs
      {
        category: ["http"],
        lowestLevel: minLevel,
        sinks: [sinkName],
      },
      // Database operations
      {
        category: ["db"],
        lowestLevel: minLevel,
        sinks: [sinkName],
      },
      // Authentication
      {
        category: ["auth"],
        lowestLevel: minLevel,
        sinks: [sinkName],
      },
      // Agent/AI operations
      {
        category: ["agent"],
        lowestLevel: minLevel,
        sinks: [sinkName],
      },
      // Connectors (Stripe, Close, etc.)
      {
        category: ["connector"],
        lowestLevel: minLevel,
        sinks: [sinkName],
      },
      // Sync operations
      {
        category: ["sync"],
        lowestLevel: minLevel,
        sinks: [sinkName],
      },
      // Query execution
      {
        category: ["query"],
        lowestLevel: minLevel,
        sinks: [sinkName],
      },
      // Workspace operations
      {
        category: ["workspace"],
        lowestLevel: minLevel,
        sinks: [sinkName],
      },
      // Flow/Inngest operations
      {
        category: ["inngest"],
        lowestLevel: minLevel,
        sinks: [sinkName],
      },
      // Flow execution logs - also stored in database for execution history
      {
        category: ["inngest", "execution"],
        lowestLevel: minLevel,
        sinks: [sinkName, "database"],
      },
      // Application lifecycle
      {
        category: ["app"],
        lowestLevel: minLevel,
        sinks: [sinkName],
      },
      // Migrations
      {
        category: ["migration"],
        lowestLevel: minLevel,
        sinks: [sinkName],
      },
      // API routes
      {
        category: ["api"],
        lowestLevel: minLevel,
        sinks: [sinkName],
      },
    ],
  });

  configured = true;
}

/**
 * Initialize the logging system
 *
 * This function is idempotent - it can be called multiple times safely.
 * The first call will configure LogTape, subsequent calls are no-ops.
 *
 * Note: Logging is auto-initialized when this module is imported,
 * so explicit calls to this function are typically not needed but
 * can be used to await completion of initialization.
 */
export async function initializeLogging(): Promise<void> {
  if (configured) {
    return;
  }
  if (initializationPromise) {
    return initializationPromise;
  }
  initializationPromise = doInitialize();
  return initializationPromise;
}

/**
 * Check if logging has been initialized
 */
export function isLoggingInitialized(): boolean {
  return configured;
}

// Auto-initialize logging when this module is imported.
// This starts the async configuration immediately, ensuring LogTape
// is configured before the main() function runs and before most
// code that uses loggers executes.
//
// Note: Loggers created at module load time (const logger = loggers.xxx())
// will work correctly because:
// 1. LogTape loggers are valid even before configure() completes
// 2. By the time any actual logging happens (in request handlers, etc.),
//    the initialization will have completed
// 3. The initialization promise is started here at import time, not
//    lazily when main() is called
void initializeLogging();

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
  auth: (provider?: string) =>
    getLogger(provider ? ["auth", provider] : ["auth"]),

  /** AI agent operations */
  agent: (model?: string) => getLogger(model ? ["agent", model] : ["agent"]),

  /** Data connectors */
  connector: (type?: string) =>
    getLogger(type ? ["connector", type] : ["connector"]),

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

  /** API routes */
  api: (route?: string) => getLogger(route ? ["api", route] : ["api"]),
} as const;
