import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import {
  chatsRepository,
  connectionsRepository,
  consolesRepository,
  pingPostgres,
  queriesRepository,
  workspacesRepository,
} from "../db";
import {
  AUTH_SECURITY,
  AuthEnv,
  STD_ERRORS,
  createRouter,
  dataResponse,
  pathParam,
  zDateTime,
} from "../openapi/core";
import { enrichContextWithWorkspace, loggers } from "../logging";

const log = loggers.api("pg-persistence");

/**
 * Read API for Mako metadata served from the **Postgres** persistence layer
 * (Drizzle repositories), documented natively with `@hono/zod-openapi`.
 *
 * Mounted at `/api/pg`. Endpoints under `/api/pg/workspaces/:workspaceId/*`
 * are session/API-key authenticated and workspace-scoped (access checked
 * against the Postgres `workspace_members` table). `/api/pg/health` is public.
 *
 * The auth middleware is injectable so the router can be exercised in isolation
 * by the e2e test without a live Mongo session.
 */

// ---- Response schemas ----

const HealthSchema = z
  .object({
    ok: z.boolean(),
    backend: z.literal("postgres"),
  })
  .openapi("PgHealth");

const ConnectionSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    isDemo: z.boolean(),
    createdBy: z.string().nullable(),
    lastConnectedAt: zDateTime().nullable(),
    hasCredentials: z.boolean(),
  })
  .openapi("PgConnectionSummary");

const ConsoleSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    language: z.string().nullable(),
    access: z.string().nullable(),
    executionCount: z.number(),
    updatedAt: zDateTime(),
  })
  .openapi("PgConsoleSummary");

const ChatSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    threadId: z.string().nullable(),
    activeAgent: z.string().nullable(),
    titleGenerated: z.boolean(),
    updatedAt: zDateTime(),
  })
  .openapi("PgChatSummary");

const ChatDetailSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    messages: z.array(z.any()),
    activeAgent: z.string().nullable(),
    updatedAt: zDateTime(),
  })
  .openapi("PgChatDetail");

const QueryExecutionSchema = z
  .object({
    id: z.string(),
    status: z.string().nullable(),
    databaseType: z.string().nullable(),
    queryLanguage: z.string().nullable(),
    rowCount: z.number().nullable(),
    durationMs: z.number().nullable(),
    createdAt: zDateTime(),
  })
  .openapi("PgQueryExecution");

const workspaceParams = z.object({ workspaceId: pathParam("workspaceId") });
const chatParams = z.object({
  workspaceId: pathParam("workspaceId"),
  chatId: pathParam("chatId"),
});

/** Workspace access guard backed by the Postgres `workspace_members` table. */
const pgWorkspaceVerify: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    return c.json({ success: false, error: "Missing workspaceId" }, 400);
  }
  const user = c.get("user");
  const workspace = c.get("workspace");

  if (workspace) {
    if (workspace._id?.toString() !== workspaceId) {
      return c.json({ success: false, error: "API key not authorized" }, 403);
    }
  } else if (user) {
    const hasAccess = await workspacesRepository.hasAccess(
      workspaceId,
      user.id,
    );
    if (!hasAccess) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
  } else {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  enrichContextWithWorkspace(workspaceId);
  await next();
};

export function createPgPersistenceRoutes(
  authMiddleware: MiddlewareHandler = unifiedAuthMiddleware,
) {
  const router = createRouter();

  router.openapi(
    createRoute({
      method: "get",
      path: "/health",
      tags: ["Postgres"],
      summary: "Postgres persistence health check",
      responses: {
        200: dataResponse(HealthSchema, "Postgres reachable"),
        ...STD_ERRORS,
      },
    }),
    async c => {
      const ok = await pingPostgres().catch(() => false);
      return c.json(
        { success: true as const, data: { ok, backend: "postgres" as const } },
        200,
      );
    },
  );

  // Protected, workspace-scoped routes.
  router.use("/workspaces/:workspaceId/*", authMiddleware);
  router.use("/workspaces/:workspaceId/*", pgWorkspaceVerify);

  router.openapi(
    createRoute({
      method: "get",
      path: "/workspaces/{workspaceId}/connections",
      tags: ["Postgres"],
      summary: "List database connections (credentials redacted)",
      security: AUTH_SECURITY,
      request: { params: workspaceParams },
      responses: {
        200: dataResponse(
          z.array(ConnectionSummarySchema),
          "Connections for the workspace",
        ),
        ...STD_ERRORS,
      },
    }),
    async c => {
      const { workspaceId } = c.req.valid("param");
      const rows = await connectionsRepository.listForWorkspace(workspaceId);
      const data = rows.map(r => ({
        id: r.id,
        name: r.name,
        type: r.type,
        isDemo: r.isDemo,
        createdBy: r.createdBy,
        lastConnectedAt: r.lastConnectedAt,
        hasCredentials: !!r.connection && Object.keys(r.connection).length > 0,
      }));
      return c.json({ success: true as const, data }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/workspaces/{workspaceId}/consoles",
      tags: ["Postgres"],
      summary: "List saved consoles",
      security: AUTH_SECURITY,
      request: { params: workspaceParams },
      responses: {
        200: dataResponse(z.array(ConsoleSummarySchema), "Consoles"),
        ...STD_ERRORS,
      },
    }),
    async c => {
      const { workspaceId } = c.req.valid("param");
      const rows = await consolesRepository.listForWorkspace(workspaceId);
      return c.json({ success: true as const, data: rows }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/workspaces/{workspaceId}/chats",
      tags: ["Postgres"],
      summary: "List chats (messages omitted)",
      security: AUTH_SECURITY,
      request: { params: workspaceParams },
      responses: {
        200: dataResponse(z.array(ChatSummarySchema), "Chats"),
        ...STD_ERRORS,
      },
    }),
    async c => {
      const { workspaceId } = c.req.valid("param");
      const rows = await chatsRepository.listForWorkspace(workspaceId);
      return c.json({ success: true as const, data: rows }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/workspaces/{workspaceId}/chats/{chatId}",
      tags: ["Postgres"],
      summary: "Get a chat with full message history",
      security: AUTH_SECURITY,
      request: { params: chatParams },
      responses: {
        200: dataResponse(ChatDetailSchema, "Chat with messages"),
        ...STD_ERRORS,
      },
    }),
    async c => {
      const { workspaceId, chatId } = c.req.valid("param");
      const chat = await chatsRepository.findById(chatId);
      if (!chat || chat.workspaceId !== workspaceId) {
        return c.json({ success: false, error: "Chat not found" }, 404);
      }
      return c.json(
        {
          success: true as const,
          data: {
            id: chat.id,
            title: chat.title,
            messages: chat.messages,
            activeAgent: chat.activeAgent,
            updatedAt: chat.updatedAt,
          },
        },
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/workspaces/{workspaceId}/queries",
      tags: ["Postgres"],
      summary: "List recent query executions",
      security: AUTH_SECURITY,
      request: { params: workspaceParams },
      responses: {
        200: dataResponse(z.array(QueryExecutionSchema), "Query executions"),
        ...STD_ERRORS,
      },
    }),
    async c => {
      const { workspaceId } = c.req.valid("param");
      const rows = await queriesRepository.listForWorkspace(workspaceId);
      return c.json({ success: true as const, data: rows }, 200);
    },
  );

  log.debug("Postgres persistence routes constructed");
  return router;
}

export const pgPersistenceRoutes = createPgPersistenceRoutes();
