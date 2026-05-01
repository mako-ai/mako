import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { serve as serveInngest } from "inngest/hono";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { consoleRoutes } from "./routes/consoles";
import { executeRoutes } from "./routes/execute";
import { databaseRoutes } from "./routes/database";
import { dataSourceRoutes } from "./routes/sources";
import { customPromptRoutes } from "./routes/custom-prompt";
import { skillsRoutes } from "./routes/skills";
import { chatsRoutes } from "./routes/chats";
import { agentRoutes } from "./routes/agent.routes";
import { adminRoutes } from "./routes/admin.routes";
import { authRoutes } from "./auth/auth.controller";
import { connectDatabase } from "./database/schema";
import { workspaceRoutes } from "./routes/workspaces";
import {
  workspaceDatabaseRoutes,
  workspaceExecuteRoutes,
} from "./routes/workspace-databases";
import { connectorRoutes } from "./routes/connectors";
import { databaseSchemaRoutes } from "./routes/database-schemas";
import { databaseTreeRoutes } from "./routes/database-tree";
import { databaseRegistry } from "./databases/registry";
import { BigQueryDatabaseDriver } from "./databases/drivers/bigquery/driver";
import { MongoDatabaseDriver } from "./databases/drivers/mongodb/driver";
import { PostgreSQLDatabaseDriver } from "./databases/drivers/postgresql/driver";
import { CloudSQLPostgresDatabaseDriver } from "./databases/drivers/cloudsql-postgres/driver";
import { CloudflareD1DatabaseDriver } from "./databases/drivers/cloudflare-d1/driver";
import { CloudflareKVDatabaseDriver } from "./databases/drivers/cloudflare-kv/driver";
import { ClickHouseDatabaseDriver } from "./databases/drivers/clickhouse/driver";
import { MySQLDatabaseDriver } from "./databases/drivers/mysql/driver";
import { RedshiftDatabaseDriver } from "./databases/drivers/redshift/driver";
import { flowRoutes } from "./routes/flows";
import { usageRoutes } from "./routes/usage";
import { billingRoutes } from "./routes/billing";
import { stripeWebhookRoutes } from "./routes/stripe-webhook";
import { dashboardRoutes } from "./routes/dashboards";
import { dashboardMaterializationRoutes } from "./routes/dashboard-materialization";
import { scheduledQueryRoutes } from "./routes/scheduled-queries";
import { notificationRulesRoutes } from "./routes/notification-rules";
import { webhookRoutes } from "./routes/webhooks";
import { getFunctions, inngest, logInngestStatus } from "./inngest";
import mongoose from "mongoose";
import { databaseConnectionService } from "./services/database-connection.service";
import { sshTunnelManager } from "./services/ssh-tunnel.service";
import { loggers, loggingMiddleware } from "./logging";
import { warmPricingCache } from "./services/gateway-pricing.service";
import { warmCatalog } from "./services/model-catalog.service";

import { getCdcEventStoreConfig } from "./sync-cdc/event-store";

// Resolve the root‐level .env file regardless of the runtime working directory
const envPath = path.resolve(__dirname, "../../.env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// Logger - LogTape initialization starts automatically when the logging module
// is imported. By the time request handlers execute, initialization will be complete.
const logger = loggers.app();

const app = new Hono();

// CORS middleware
app.use(
  "*",
  cors({
    origin: process.env.CLIENT_URL || "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

// Compress API responses, including streaming export responses.
app.use("*", compress());

// Logging middleware - must be before other middleware to capture all requests
// Skip logging for noisy routes (Inngest polling, health checks) in development
app.use(
  "*",
  loggingMiddleware({
    skipSuccessInDev: ["/api/inngest", "/health"],
  }),
);

// Global JSON error handler – ensures errors are returned as JSON
app.onError((err, c) => {
  logger.error("Unhandled API error", {
    error: err,
    path: c.req.path,
    method: c.req.method,
  });
  const message = err instanceof Error ? err.message : "Internal Server Error";
  return c.json({ success: false, error: message }, 500);
});

// Not found handler for unknown routes
app.notFound(c => c.json({ success: false, error: "Not Found" }, 404));

// Health check
app.get("/health", c => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API routes
app.route("/api/auth", authRoutes);
app.route("/api/workspaces", workspaceRoutes);
app.route("/api/workspaces/:workspaceId/databases", workspaceDatabaseRoutes);
app.route("/api/workspaces/:workspaceId/execute", workspaceExecuteRoutes);
app.route("/api/workspaces/:workspaceId/consoles", consoleRoutes);
app.route("/api/workspaces/:workspaceId/chats", chatsRoutes);
app.route("/api/workspaces/:workspaceId/custom-prompt", customPromptRoutes);
app.route("/api/workspaces/:workspaceId/skills", skillsRoutes);
// Connectors routes
app.route("/api/workspaces/:workspaceId/connectors", dataSourceRoutes);
app.route("/api/workspaces/:workspaceId/flows", flowRoutes);
app.route(
  "/api/workspaces/:workspaceId/scheduled-queries",
  scheduledQueryRoutes,
);
app.route(
  "/api/workspaces/:workspaceId/notification-rules",
  notificationRulesRoutes,
);
app.route("/api/workspaces/:workspaceId/usage", usageRoutes);
app.route("/api/workspaces/:workspaceId/billing", billingRoutes);
app.route("/api/workspaces/:workspaceId/dashboards", dashboardRoutes);
app.route(
  "/api/workspaces/:workspaceId/dashboards/:dashboardId",
  dashboardMaterializationRoutes,
);
app.route("/api/run", executeRoutes);
app.route("/api/execute", executeRoutes);
app.route("/api/database", databaseRoutes);
app.route("/api/agent", agentRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/connectors", connectorRoutes);
app.route("/api/databases", databaseSchemaRoutes);
app.route("/api/workspaces/:workspaceId/databases", databaseTreeRoutes);

// Register database drivers
databaseRegistry.register(new BigQueryDatabaseDriver());
databaseRegistry.register(new MongoDatabaseDriver());
databaseRegistry.register(new PostgreSQLDatabaseDriver());
databaseRegistry.register(new MySQLDatabaseDriver());
databaseRegistry.register(new CloudSQLPostgresDatabaseDriver());
databaseRegistry.register(new CloudflareD1DatabaseDriver());
databaseRegistry.register(new CloudflareKVDatabaseDriver());
databaseRegistry.register(new ClickHouseDatabaseDriver());
databaseRegistry.register(new RedshiftDatabaseDriver());
app.route("/api", webhookRoutes);
app.route("/api/webhooks/stripe", stripeWebhookRoutes);

// Inngest endpoint
app.on(
  ["GET", "PUT", "POST"],
  "/api/inngest",
  serveInngest({
    client: inngest,
    functions: getFunctions(),
  }),
);

// Serve static files (frontend) - middleware for non-API routes
app.use("*", async (c, next) => {
  const requestPath = c.req.path;

  // Skip API routes and health check - let them continue to their handlers
  if (requestPath.startsWith("/api/") || requestPath === "/health") {
    await next();
    return;
  }

  // Try to serve static file
  const publicPath = path.join(process.cwd(), "public");
  const filePath = path.join(publicPath, requestPath);

  // If path doesn't have extension, try adding .html or serve index.html
  if (!path.extname(filePath)) {
    const indexPath = path.join(publicPath, "index.html");
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, "utf8");
      return c.html(content);
    }
  }

  // Try to serve the actual file
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const contentType = getContentType(ext);
    const content = fs.readFileSync(filePath);
    return c.body(content, { headers: { "Content-Type": contentType } });
  }

  // Fallback to index.html for SPA routing
  const indexPath = path.join(publicPath, "index.html");
  if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath, "utf8");
    return c.html(content);
  }

  return c.text("Frontend not found", 404);
});

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  return types[ext] || "application/octet-stream";
}

const port = parseInt(process.env.WEB_API_PORT || process.env.PORT || "8080");

/**
 * Main entry point - starts the server
 * Note: Logging is auto-initialized via top-level await in the logging module,
 * so all loggers created at module level are already configured
 */
async function main(): Promise<void> {
  if (fs.existsSync(envPath)) {
    logger.info("Loaded environment variables", { path: envPath });
  } else {
    logger.warn(
      "No .env file found, environment variables must be set another way",
      { path: envPath },
    );
  }

  // Connect to MongoDB
  try {
    await connectDatabase();
  } catch (error) {
    logger.error("Failed to connect to database", { error });
    throw error;
  }

  // Log Inngest configuration status (after logging is initialized)
  logInngestStatus();

  // Log server startup info
  const cdcEventStore = getCdcEventStoreConfig();
  logger.info("Server starting", {
    port,
    environment: process.env.NODE_ENV || "development",
    cdcEventStore,
    endpoints: {
      api: "/api/*",
      inngest: "/api/inngest",
      health: "/health",
    },
  });

  // Start the server
  serve({
    fetch: app.fetch,
    port,
  });

  if (!process.env.AI_GATEWAY_API_KEY) {
    logger.error(
      "AI_GATEWAY_API_KEY is not set. AI features will not work. " +
        "Generate a key at: Vercel Dashboard > AI Gateway settings.",
    );
  }

  warmPricingCache().catch(err => {
    logger.warn("Startup pricing cache warm failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  warmCatalog().catch(err => {
    logger.warn("Startup model catalog warm failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

let isShuttingDown = false;

function terminateProcess(signal: NodeJS.Signals, exitCode: number): void {
  process.exitCode = exitCode;
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
  process.kill(process.pid, signal);
}

// Start the application
main().catch(error => {
  // Use console.error here since logging might not be initialized
  console.error("Fatal error during startup:", error);
  void gracefulShutdown("SIGTERM", 1);
});

// Graceful shutdown handling
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

// Process-level safety nets: log and keep server responsive
process.on("unhandledRejection", reason => {
  logger.error("Unhandled Promise Rejection", { reason });
});

process.on("uncaughtException", err => {
  logger.error("Uncaught Exception", { error: err });
  void gracefulShutdown("SIGTERM", 1);
});

async function gracefulShutdown(
  signal: NodeJS.Signals,
  forcedExitCode?: number,
): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info("Graceful shutdown initiated", { signal });

  let exitCode = forcedExitCode ?? 0;
  try {
    // Close SSH tunnels
    logger.info("Closing SSH tunnels");
    await sshTunnelManager.closeAll();

    // Close unified MongoDB connection pool
    logger.info("Closing MongoDB connection pool");
    await databaseConnectionService.closeAllConnections();
    logger.info("MongoDB connection pool closed");

    // Close mongoose connection if open
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      logger.info("Mongoose connection closed");
    }
  } catch (error) {
    logger.error("Error during graceful shutdown", { error });
    exitCode = 1;
  } finally {
    logger.info("Graceful shutdown complete");
    terminateProcess(signal, exitCode);
  }
}
