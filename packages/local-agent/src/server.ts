/**
 * Mako Local Agent HTTP server.
 *
 * A small daemon bound to 127.0.0.1 that lets the Mako web app (app.mako.ai
 * or localhost dev) execute queries and browse schemas on databases that are
 * only reachable from this machine. Mirrors the request/response envelopes of
 * the cloud API so the frontend stores can route by connection id.
 *
 * Security model (Figma Font Helper / Postman Desktop Agent style):
 * - Listens on loopback only; never reachable from the network.
 * - Browser access is restricted by a strict CORS origin allowlist.
 * - Connection credentials are encrypted at rest and never returned by the
 *   list endpoint; the detail endpoint exists for the edit dialog only.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { databaseConnectionService } from "../../../api/src/services/database-connection.service";
import { checkPreviewQuerySafety } from "../../../api/src/services/query-pagination.service";
import { databaseRegistry } from "../../../api/src/databases/registry";
import { buildConsoleTemplate } from "../../../api/src/databases/console-template";
import { loggers } from "../../../api/src/logging";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  touchLastConnected,
  updateConnection,
} from "./connection-store";
import { registerDrivers, toDatabaseConnection } from "./database-bridge";
import { registerAcpRoutes } from "./acp/routes";
import { acpSessionManager } from "./acp/manager";
import { ensureNpmGlobalPath } from "./acp/path-env";
import { registerDesktopBridgeRoutes } from "./desktop-bridge/routes";

const logger = loggers.api("local-agent");

// Desktop GUI PATH is often stripped; prepend Homebrew / npm-global bins so
// `claude-agent-acp` resolves after `npm i -g` instead of falling back to npx.
ensureNpmGlobalPath();

export const DEFAULT_AGENT_PORT = 41720;

export const AGENT_VERSION = "0.1.0";

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://app.mako.ai",
];

const PR_PREVIEW_ORIGIN = /^https:\/\/pr-\d+\.mako\.ai$/;

function isAllowedOrigin(origin: string): boolean {
  if (DEFAULT_ALLOWED_ORIGINS.includes(origin)) return true;
  if (PR_PREVIEW_ORIGIN.test(origin)) return true;
  const extra = (process.env.MAKO_AGENT_ALLOWED_ORIGINS || "")
    .split(",")
    .map(o => o.trim())
    .filter(Boolean);
  return extra.includes(origin);
}

interface QueryRequestBody {
  connectionId?: string;
  query?: unknown;
  language?: string;
  mongoOptions?: { collection?: string; operation?: string };
  databaseId?: string;
  databaseName?: string;
  executionId?: string;
  mode?: string;
  pageSize?: number | string;
  cursor?: string | null;
  confirmUnsafe?: boolean;
}

/** Mirrors buildExecutableQuery in api/src/routes/workspace-databases.ts. */
function buildExecutableQuery(
  body: QueryRequestBody,
  databaseType: string,
): unknown | null {
  const code = body.query;
  if (typeof code !== "string" || !code.trim()) return null;
  if (
    databaseType === "mongodb" &&
    body.language === "mongodb" &&
    body.mongoOptions?.collection
  ) {
    return {
      collection: body.mongoOptions.collection,
      operation: body.mongoOptions.operation || "find",
      query: code,
    };
  }
  return code;
}

export function createAgentApp(): Hono {
  registerDrivers();

  const app = new Hono();

  // Chrome Private Network Access preflight (predecessor of Local Network
  // Access): acknowledge so older Chrome versions don't block the request.
  // Registered before the CORS middleware (which finalizes OPTIONS) so the
  // header is appended to the preflight response.
  app.use("*", async (c, next) => {
    await next();
    if (
      c.req.method === "OPTIONS" &&
      c.req.header("Access-Control-Request-Private-Network") === "true"
    ) {
      c.res.headers.set("Access-Control-Allow-Private-Network", "true");
    }
  });

  app.use(
    "*",
    cors({
      origin: origin => (origin && isAllowedOrigin(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      maxAge: 86400,
    }),
  );

  app.onError((err, c) => {
    logger.error("Unhandled agent error", {
      error: err,
      path: c.req.path,
      method: c.req.method,
    });
    const message =
      err instanceof Error ? err.message : "Internal Server Error";
    return c.json({ success: false, error: message }, 500);
  });

  app.notFound(c => c.json({ success: false, error: "Not Found" }, 404));

  // --- Discovery -----------------------------------------------------------

  app.get("/health", c =>
    c.json({
      status: "ok",
      name: "mako-local-agent",
      version: AGENT_VERSION,
      timestamp: new Date().toISOString(),
    }),
  );

  // --- Connection management ----------------------------------------------

  // List local connections. Mirrors GET /api/workspaces/:id/databases:
  // credentials are never included.
  app.get("/connections", c => {
    const data = listConnections().map(local => {
      const conn = local.connection as Record<string, unknown>;
      const host = (conn.host as string) || "localhost";
      const hostName = `${local.type.toUpperCase()} (${host} • local)`;
      return {
        id: local.id,
        connectionId: local.id,
        name: local.name,
        description: "",
        database: (conn.database as string) || "",
        type: local.type,
        active: true,
        lastConnectedAt: local.lastConnectedAt,
        isClusterMode: !conn.database,
        isDemo: false,
        isLocal: true,
        displayName: local.name || (conn.database as string) || "Local Database",
        hostKey: `local://${host}`,
        hostName,
      };
    });
    return c.json({ success: true, data });
  });

  // Connection detail (for the edit dialog). Local-only endpoint; includes
  // decrypted connection config like the cloud GET /databases/:id does.
  app.get("/connections/:id", c => {
    const local = getConnection(c.req.param("id"));
    if (!local) {
      return c.json({ success: false, error: "Connection not found" }, 404);
    }
    const conn = local.connection as Record<string, unknown>;
    return c.json({
      success: true,
      data: {
        id: local.id,
        connectionId: local.id,
        name: local.name,
        type: local.type,
        connection: local.connection,
        databaseName: conn.database,
        isClusterMode: !conn.database,
        isLocal: true,
        createdAt: local.createdAt,
        updatedAt: local.updatedAt,
        lastConnectedAt: local.lastConnectedAt,
      },
    });
  });

  app.post("/connections", async c => {
    const body = await c.req.json();
    if (!body?.name || !body?.type || typeof body.connection !== "object") {
      return c.json(
        { success: false, error: "name, type and connection are required" },
        400,
      );
    }
    const local = createConnection({
      name: String(body.name),
      type: String(body.type),
      connection: body.connection,
    });
    logger.info("Created local connection", {
      connectionId: local.id,
      databaseType: local.type,
    });
    return c.json({ success: true, data: { _id: local.id, id: local.id } });
  });

  app.put("/connections/:id", async c => {
    const body = await c.req.json();
    const local = updateConnection(c.req.param("id"), {
      name: body?.name ? String(body.name) : undefined,
      connection:
        body?.connection && typeof body.connection === "object"
          ? body.connection
          : undefined,
    });
    if (!local) {
      return c.json({ success: false, error: "Connection not found" }, 404);
    }
    return c.json({ success: true, data: { _id: local.id, id: local.id } });
  });

  app.delete("/connections/:id", c => {
    const deleted = deleteConnection(c.req.param("id"));
    if (!deleted) {
      return c.json({ success: false, error: "Connection not found" }, 404);
    }
    return c.json({ success: true });
  });

  // Test an unsaved connection config (mirrors POST /databases/test-connection).
  app.post("/test-connection", async c => {
    const body = await c.req.json();
    if (!body?.type || typeof body.connection !== "object") {
      return c.json(
        { success: false, error: "type and connection are required" },
        400,
      );
    }
    const result = await databaseConnectionService.testConnection(
      toDatabaseConnection({
        id: "local_test",
        name: "test",
        type: String(body.type),
        connection: body.connection,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    return c.json(result);
  });

  // --- Schema browsing ------------------------------------------------------

  app.get("/connections/:id/tree", async c => {
    const local = getConnection(c.req.param("id"));
    if (!local) {
      return c.json({ success: false, error: "Connection not found" }, 404);
    }
    const driver = databaseRegistry.getDriver(local.type);
    if (!driver) {
      return c.json({ success: false, error: "Driver not found" }, 404);
    }
    const database = toDatabaseConnection(local);
    const nodeId = c.req.query("nodeId");
    const metadataRaw = c.req.query("metadata");
    if (!nodeId) {
      const nodes = await driver.getTreeRoot(database);
      return c.json({ success: true, data: nodes });
    }
    const metadata = metadataRaw ? JSON.parse(metadataRaw) : undefined;
    const nodes = await driver.getChildren(database, {
      id: String(nodeId),
      kind: String(c.req.query("kind") || ""),
      metadata,
    });
    return c.json({ success: true, data: nodes });
  });

  app.get("/connections/:id/autocomplete", async c => {
    const local = getConnection(c.req.param("id"));
    if (!local) {
      return c.json({ success: false, error: "Connection not found" }, 404);
    }
    const driver = databaseRegistry.getDriver(local.type);
    if (!driver?.getAutocompleteData) {
      return c.json(
        {
          success: false,
          error: "Autocomplete not supported for this database type",
        },
        400,
      );
    }
    try {
      const schema = await driver.getAutocompleteData(
        toDatabaseConnection(local),
      );
      return c.json({ success: true, data: schema });
    } catch (error) {
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch autocomplete data",
        },
        500,
      );
    }
  });

  app.get("/connections/:id/console-template", c => {
    const local = getConnection(c.req.param("id"));
    if (!local) {
      return c.json({ success: false, error: "Connection not found" }, 404);
    }
    const metadataRaw = c.req.query("metadata");
    const data = buildConsoleTemplate(toDatabaseConnection(local), {
      id: c.req.query("nodeId"),
      kind: c.req.query("kind"),
      metadata: metadataRaw ? JSON.parse(metadataRaw) : undefined,
    });
    return c.json({ success: true, data });
  });

  app.get("/connections/:id/table-definition", async c => {
    const local = getConnection(c.req.param("id"));
    if (!local) {
      return c.json({ success: false, error: "Connection not found" }, 404);
    }
    const table = c.req.query("table");
    if (!table) {
      return c.json({ success: false, error: "table is required" }, 400);
    }
    const driver = databaseRegistry.getDriver(local.type);
    if (!driver?.getTableDefinition) {
      return c.json(
        {
          success: false,
          error: `Table definition not supported for ${local.type}`,
        },
        400,
      );
    }
    const databaseName = c.req.query("database");
    const result = await driver.getTableDefinition(
      toDatabaseConnection(local),
      {
        schema: String(c.req.query("schema") || "public"),
        table: String(table),
        databaseName: databaseName ? String(databaseName) : undefined,
      },
    );
    if (!result.success) {
      return c.json(
        {
          success: false,
          error: result.error || "Failed to fetch table definition",
        },
        500,
      );
    }
    return c.json({ success: true, data: { definition: result.definition } });
  });

  // --- Query execution ------------------------------------------------------

  // Mirrors POST /api/workspaces/:workspaceId/execute (preview mode + safety
  // checks). No admin gate for confirmUnsafe: the user owns this machine and
  // database, so the confirmation dialog is protection enough.
  app.post("/execute", async c => {
    const body = (await c.req.json()) as QueryRequestBody;
    const connectionId = body.connectionId;
    if (!connectionId) {
      return c.json({ success: false, error: "connectionId is required" }, 400);
    }
    const local = getConnection(connectionId);
    if (!local) {
      return c.json(
        { success: false, error: "Database connection not found" },
        404,
      );
    }
    const executableQuery = buildExecutableQuery(body, local.type);
    if (!executableQuery) {
      return c.json({ success: false, error: "query is required" }, 400);
    }

    const options = {
      databaseId: body.databaseId,
      databaseName: body.databaseName,
      executionId: body.executionId,
    };

    const isPreviewMode = body.mode === "preview";
    let useFullExecute = !isPreviewMode;

    if (
      isPreviewMode &&
      typeof executableQuery === "string" &&
      local.type !== "mongodb" &&
      local.type !== "cloudflare-kv"
    ) {
      const safety = checkPreviewQuerySafety(executableQuery);
      if (!safety.safe) {
        if (!body.confirmUnsafe) {
          return c.json(
            {
              success: false,
              error: safety.errors.join(" "),
              code: "PREVIEW_BLOCKED" as const,
            },
            400,
          );
        }
        useFullExecute = true;
      }
    }

    const database = toDatabaseConnection(local);
    const startTime = Date.now();
    const result = useFullExecute
      ? await databaseConnectionService.executeQuery(
          database,
          executableQuery,
          options,
        )
      : await databaseConnectionService.executePreviewQuery(
          database,
          executableQuery,
          {
            ...options,
            pageSize:
              typeof body.pageSize === "string"
                ? parseInt(body.pageSize, 10)
                : body.pageSize,
            cursor: typeof body.cursor === "string" ? body.cursor : null,
          },
        );

    if (result.success) {
      touchLastConnected(local.id);
    }
    logger.info("Executed local query", {
      connectionId: local.id,
      databaseType: local.type,
      success: result.success,
      duration_ms: Date.now() - startTime,
    });

    return c.json(result);
  });

  app.post("/execute/cancel", async c => {
    const body = await c.req.json();
    if (!body?.executionId) {
      return c.json({ success: false, error: "executionId is required" }, 400);
    }
    const result = await databaseConnectionService.cancelQuery(
      String(body.executionId),
    );
    return c.json(result);
  });

  // --- ACP coding agents (Claude Code / Codex via local stdio adapters) ---
  registerAcpRoutes(app);
  registerDesktopBridgeRoutes(app);

  return app;
}

export interface StartedAgent {
  port: number;
  close: () => Promise<void>;
}

export function startAgent(port?: number): StartedAgent {
  const resolvedPort =
    port ??
    (process.env.MAKO_AGENT_PORT
      ? parseInt(process.env.MAKO_AGENT_PORT, 10)
      : DEFAULT_AGENT_PORT);

  const app = createAgentApp();
  const server = serve({
    fetch: app.fetch,
    port: resolvedPort,
    hostname: "127.0.0.1",
  });

  logger.info("Mako Local Agent listening", {
    port: resolvedPort,
    host: "127.0.0.1",
  });

  return {
    port: resolvedPort,
    close: async () => {
      await acpSessionManager.shutdown();
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
