import { OpenAPIHono } from "@hono/zod-openapi";
import { serve } from "@hono/node-server";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { serve as serveInngest } from "inngest/hono";
import { Scalar } from "@scalar/hono-api-reference";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { connectDatabase } from "./database/schema";
import { registerApiRoutes } from "./routes/register-routes";
import { mcpOAuthWellKnownRoutes } from "./routes/mcp-oauth.routes";
import { getOpenApiDocument } from "./openapi";
import type { AuthEnv } from "./openapi/core";
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
import { getFunctions, inngest, logInngestStatus } from "./inngest";
import mongoose from "mongoose";
import { databaseConnectionService } from "./services/database-connection.service";
import { sshTunnelManager } from "./services/ssh-tunnel.service";
import { loggers, loggingMiddleware } from "./logging";
import { checkPubSubBackendHealth } from "./services/pubsub.service";
import { warmPricingCache } from "./services/gateway-pricing.service";
import { warmCatalog } from "./services/model-catalog.service";
import { discoverSystemSkills } from "./agent-lib/skills/system-skills";

import { getCdcEventStoreConfig } from "./sync-cdc/event-store";
import {
  initLangfuseTracing,
  shutdownLangfuse,
} from "./observability/langfuse";

// Resolve the root‐level .env file regardless of the runtime working directory
const envPath = path.resolve(__dirname, "../../.env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// Initialize Langfuse tracing AFTER env vars are loaded but before the server
// handles any request. Registers the OpenTelemetry provider that the Vercel AI
// SDK emits GenAI spans into. No-op when Langfuse keys are absent.
initLangfuseTracing();

// Logger - LogTape initialization starts automatically when the logging module
// is imported. By the time request handlers execute, initialization will be complete.
const logger = loggers.app();

const REQUIRED_SYSTEM_SKILLS = [
  "dialect-postgresql",
  "dialect-bigquery",
  "dialect-clickhouse",
  "dialect-mysql",
  "dialect-sqlite",
  "mongodb-queries",
  "dashboards",
  "flows",
];

const app = new OpenAPIHono<AuthEnv>();

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

// OAuth discovery for the Mako MCP endpoint (RFC 9728 + RFC 8414). Root-level
// well-known documents, so registered here rather than in register-routes.ts.
app.route("/", mcpOAuthWellKnownRoutes);

// Frontend build version - public, used by long-lived clients (especially the
// desktop app) to detect that their loaded bundle is stale and prompt a
// reload. The build ID is emitted into public/version.json by the Vite build
// (git SHA in CI), so it is always in sync with the bundle shipped in this
// image. Falls back to "dev" locally where no version.json exists.
let cachedBuildId: string | null = null;
function getFrontendBuildId(): string {
  if (cachedBuildId === null) {
    try {
      const versionPath = path.join(process.cwd(), "public", "version.json");
      const parsed = JSON.parse(fs.readFileSync(versionPath, "utf8")) as {
        buildId?: unknown;
      };
      cachedBuildId =
        typeof parsed.buildId === "string" && parsed.buildId
          ? parsed.buildId
          : "dev";
    } catch {
      cachedBuildId = "dev";
    }
  }
  return cachedBuildId;
}

app.get("/api/version", c => {
  // no-store: this endpoint exists to detect new deploys, so neither the
  // browser nor any CDN in front may ever serve a cached response.
  c.header("Cache-Control", "no-store");
  return c.json({ buildId: getFrontendBuildId() });
});

// API routes — single source of truth for the documented REST surface.
// Shared with the OpenAPI generator so docs can never drift from the server.
registerApiRoutes(app);

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

// OpenAPI specification (machine-readable) and interactive reference UI.
// Both are public so agents and external clients can discover the API surface.
app.get("/api/openapi.json", c => c.json(getOpenApiDocument()));
app.get(
  "/api/reference",
  Scalar({
    url: "/api/openapi.json",
    pageTitle: "Mako API Reference",
    theme: "purple",
  }),
);

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
      // index.html must always be revalidated so a reload after a deploy
      // picks up the new bundle (stale-client detection depends on this).
      c.header("Cache-Control", "no-cache");
      return c.html(content);
    }
  }

  // Try to serve the actual file
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const contentType = getContentType(ext);
    const content = fs.readFileSync(filePath);
    // Vite assets are content-hashed, so they can be cached forever; anything
    // else (index.html handled above) gets revalidation.
    const cacheControl = requestPath.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache";
    return c.body(content, {
      headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
    });
  }

  // Fallback to index.html for SPA routing
  const indexPath = path.join(publicPath, "index.html");
  if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath, "utf8");
    c.header("Cache-Control", "no-cache");
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

  const systemSkillRegistry = discoverSystemSkills();
  const missingSystemSkills = REQUIRED_SYSTEM_SKILLS.filter(
    name => !systemSkillRegistry.skills.has(name),
  );
  if (missingSystemSkills.length > 0) {
    throw new Error(
      `Missing required system skills: ${missingSystemSkills.join(", ")}. ` +
        "Ensure api/src/agent-skills/**/*.md is bundled into dist (copyfiles).",
    );
  }
  logger.info("System skills discovered", {
    count: systemSkillRegistry.skills.size,
    skillsDir: systemSkillRegistry.skillsDir,
  });

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

  // Redis pub/sub health (resumable chat streams + workspace realtime).
  // Logs an ERROR when REDIS_URL is set but the backend is unusable
  // (connectivity, auth, or provider quota) so the degradation is visible
  // from boot instead of hiding behind per-turn warnings.
  checkPubSubBackendHealth().catch(err => {
    logger.warn("Pub/sub health check failed to run", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

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
    // Flush buffered Langfuse spans before the process exits
    logger.info("Flushing Langfuse traces");
    await shutdownLangfuse();

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
