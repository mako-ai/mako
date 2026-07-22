/**
 * Notebook data-access routes.
 *
 * `POST /api/workspaces/:workspaceId/notebook/read` is the single, read-only,
 * budgeted surface a notebook kernel can reach. The kernel holds no database
 * credentials — the `mako` Python SDK sends a query here and the control plane
 * runs it through the existing driver layer and streams Arrow IPC back.
 *
 * Auth accepts either a short-lived kernel token (minted per session) or the
 * standard session/workspace-API-key credential, so the endpoint is usable from
 * both a sandboxed kernel and normal programmatic clients.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
import { Types } from "mongoose";

import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { requireWorkspace } from "../middleware/workspace.middleware";
import { DatabaseConnection, Workspace } from "../database/workspace-schema";
import { databaseConnectionService } from "../services/database-connection.service";
import {
  applySqlRowLimit,
  checkPreviewQuerySafety,
} from "../services/query-pagination.service";
import { getSqlDialectOrNull } from "../agent-lib/tools/shared/sql-dialects";
import { createArrowIPCStreamResponse } from "../utils/arrow-serializer";
import {
  isKernelToken,
  verifyKernelToken,
} from "../services/kernel-token.service";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  jsonBody,
  pathParam,
} from "../openapi/core";
import { loggers } from "../logging";

const logger = loggers.db();

/** Hard ceiling on rows a single notebook read returns (env-overridable). */
const MAX_ROWS = parseInt(process.env.NOTEBOOK_READ_MAX_ROWS || "1000000", 10);

export const notebookDataRoutes = createRouter();

/**
 * Accept a kernel token (Bearer mnk_…) OR fall back to the standard
 * session/API-key auth. On a valid kernel token we set only `workspace` (no
 * `user`), which `requireWorkspace` treats like an API key: it verifies the
 * path workspace matches and skips the per-user membership re-check (the
 * short-lived token is itself the authorization).
 */
async function kernelOrUnifiedAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (isKernelToken(token)) {
      let payload;
      try {
        payload = verifyKernelToken(token);
      } catch (error) {
        return c.json(
          {
            success: false,
            error:
              error instanceof Error ? error.message : "Invalid kernel token",
          },
          401,
        );
      }
      if (!Types.ObjectId.isValid(payload.wsId)) {
        return c.json(
          { success: false, error: "Invalid workspace in kernel token" },
          401,
        );
      }
      const workspace = await Workspace.findById(payload.wsId);
      if (!workspace) {
        return c.json(
          { success: false, error: "Workspace not found for kernel token" },
          401,
        );
      }
      c.set("workspace", workspace);
      c.set("workspaceId", workspace._id.toString());
      c.set("authType", "apiKey");
      logger.info("Notebook read authorized via kernel token", {
        workspaceId: workspace._id.toString(),
        userId: payload.userId,
        notebookId: payload.notebookId,
      });
      await next();
      return;
    }
  }
  return unifiedAuthMiddleware(c, next);
}

const ReadRequestSchema = z
  .object({
    connectionId: z.string().openapi({ example: "507f1f77bcf86cd799439011" }),
    query: z.string().openapi({ example: "select date, mrr from metrics.mrr" }),
    limit: z.number().int().positive().optional(),
    params: z.record(z.string(), z.any()).optional(),
    // Accepted for forward-compat; reads always stream Arrow.
    format: z.string().optional(),
  })
  .openapi("NotebookReadRequest");

// GET /api/workspaces/:workspaceId/notebook/sources
// The SDK's source list — `mako.sources.list()` / `.resolve()` map a source
// NAME to a connection id from inside the sandbox. Kernel-token authed (same as
// /read) and deliberately minimal: id, name, type ONLY — never the credentialed
// connection doc (the generic /databases route decrypts creds and must not be
// reachable by a kernel token).
notebookDataRoutes.openapi(
  createRoute({
    method: "get",
    path: "/sources",
    tags: ["Notebooks"],
    security: AUTH_SECURITY,
    middleware: [kernelOrUnifiedAuth, requireWorkspace] as const,
    request: {
      params: z.object({ workspaceId: pathParam("workspaceId") }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspace = c.get("workspace") as { _id: unknown };
    const rows = await DatabaseConnection.find({
      workspaceId: new Types.ObjectId(String(workspace._id)),
    })
      .select("_id name type")
      .lean();
    const data = rows.map(r => ({
      id: String(r._id),
      name: (r as { name?: string }).name ?? "",
      type: (r as { type?: string }).type ?? "",
    }));
    return c.json({ success: true, data });
  },
);

// POST /api/workspaces/:workspaceId/notebook/read
notebookDataRoutes.openapi(
  createRoute({
    method: "post",
    path: "/read",
    tags: ["Notebooks"],
    security: AUTH_SECURITY,
    middleware: [kernelOrUnifiedAuth, requireWorkspace] as const,
    request: {
      params: z.object({ workspaceId: pathParam("workspaceId") }),
      body: jsonBody(ReadRequestSchema),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspace = c.get("workspace");
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const connectionId =
        typeof body.connectionId === "string" ? body.connectionId : undefined;
      const query = typeof body.query === "string" ? body.query : undefined;

      if (!connectionId) {
        return c.json(
          { success: false, error: "connectionId is required" },
          400,
        );
      }
      if (!query || !query.trim()) {
        return c.json({ success: false, error: "query is required" }, 400);
      }
      if (!Types.ObjectId.isValid(connectionId)) {
        return c.json(
          { success: false, error: "Invalid connectionId format" },
          400,
        );
      }
      // Parameter binding is not wired yet; reject rather than silently ignore
      // (a caller relying on binding for safety must not be misled).
      if (body.params !== undefined) {
        return c.json(
          {
            success: false,
            error:
              "params (server-side binding) is not supported yet; inline values safely or omit params",
            code: "PARAMS_UNSUPPORTED",
          },
          400,
        );
      }

      const database = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(connectionId),
        workspaceId: workspace._id,
      });
      if (!database) {
        return c.json(
          { success: false, error: "Database connection not found" },
          404,
        );
      }

      // Notebook reads are SQL-only; the read-only guard + row-limit wrapper
      // are SQL constructs. (Mongo/KV sources are out of scope for this path.)
      const dialect = getSqlDialectOrNull(database.type);
      if (!dialect) {
        return c.json(
          {
            success: false,
            error: `notebook read supports SQL sources only (got '${database.type}')`,
          },
          400,
        );
      }

      const safety = checkPreviewQuerySafety(query);
      if (!safety.safe) {
        return c.json(
          {
            success: false,
            error: safety.errors.join(" "),
            code: "NOT_READ_ONLY",
          },
          400,
        );
      }

      // Row budget: clamp the caller's limit to the ceiling and wrap the query
      // in a LIMIT so a runaway SELECT can't stream unbounded rows.
      const requested =
        typeof body.limit === "number" && body.limit > 0
          ? Math.floor(body.limit)
          : MAX_ROWS;
      const effectiveLimit = Math.min(requested, MAX_ROWS);
      let executableQuery: string;
      try {
        executableQuery = applySqlRowLimit({
          query,
          databaseType: database.type,
          limit: effectiveLimit,
        });
      } catch {
        executableQuery = query;
      }

      const streamingOptions = {
        batchSize: 5000,
        signal: c.req.raw.signal,
      };

      const fieldsResult =
        await databaseConnectionService.getStreamingQueryFields(
          database,
          executableQuery,
          streamingOptions,
        );
      if (!fieldsResult.success || !fieldsResult.fields?.length) {
        return c.json(
          {
            success: false,
            error:
              fieldsResult.error ||
              "Failed to resolve result schema for the query",
          },
          400,
        );
      }

      return createArrowIPCStreamResponse({
        fields: fieldsResult.fields,
        filename: "notebook-read",
        streamRows: emitRows =>
          databaseConnectionService.executeStreamingQuery(
            database,
            executableQuery,
            { ...streamingOptions, onBatch: emitRows },
          ),
      });
    } catch (error) {
      logger.error("Notebook read failed", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Notebook read failed",
        },
        500,
      );
    }
  },
);
