/**
 * Reading consoles: the explorer tree, one console's editor content, the
 * bulk revision sync, search, and the flat list / details / executions API
 * clients use. Without a GitHub binding the list reads are empty (200),
 * one-console reads are 404 — never 412.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { RepoRequiredError } from "../../apps/config";
import { isApiKeyAuth } from "../../auth/unified-auth.middleware";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  queryParam,
} from "../../openapi/core";
import { listConsoles, listConsolesSplit } from "../../services/consoles";
import {
  consoleContent,
  consoleDetails,
  consoleExecutions,
  listConsoleSummaries,
  syncConsoleRevisions,
} from "../../services/consoles/views";
import { fail } from "../lib/respond";
import {
  accessDenied,
  consoleIdParams,
  emptyConsoleTree,
  logger,
  looseJsonBody,
  serverError,
  wsParams,
} from "./shared";

export const consoleReadRoutes = createRouter();

// GET /api/workspaces/:workspaceId/consoles - List all consoles (tree structure) for workspace
consoleReadRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Consoles"],
    summary: "GET /",
    security: AUTH_SECURITY,
    request: { params: wsParams },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      // Access was verified by the router middleware; only the id is needed.
      const workspaceId = c.req.param("workspaceId") as string;
      const userId = c.get("user")?.id;

      if (userId) {
        const { myConsoles, sharedWithWorkspace } = await listConsolesSplit(
          workspaceId,
          userId,
        );
        return c.json({
          success: true,
          myConsoles,
          sharedWithWorkspace,
          tree: myConsoles,
        });
      }

      const tree = await listConsoles(workspaceId, userId);
      return c.json({ success: true, tree });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json(emptyConsoleTree(), 200);
      }
      logger.error("Error listing consoles", { error });
      return fail(
        c,
        500,
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/consoles/content - Get specific console content
consoleReadRoutes.openapi(
  createRoute({
    method: "get",
    path: "/content",
    tags: ["Consoles"],
    summary: "GET /content",
    security: AUTH_SECURITY,
    request: {
      params: wsParams,
      query: z.object({ id: queryParam("id") }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      if (!user) return accessDenied(c);

      const consoleId = c.req.query("id");
      if (!consoleId) {
        return fail(c, 400, "ID query parameter is required");
      }

      const content = await consoleContent({
        workspaceId: c.req.param("workspaceId") as string,
        consoleId,
        userId: user.id,
        memberRole: c.get("memberRole"),
      });
      if (!content) return fail(c, 404, "Console not found");
      return c.json({ success: true, ...content });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return fail(c, 404, "Console not found");
      }
      logger.error("Error fetching console content", {
        consoleId: c.req.query("id"),
        error,
      });
      return fail(
        c,
        404,
        error instanceof Error ? error.message : "Console not found",
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/consoles/revisions-sync
//
// Bulk poke-then-pull reconciliation: the client sends the draftRevision of
// every console tab it has open; the server returns full payloads for the
// ones that changed. Called on realtime (re)connect and on tab focus, which
// makes reconnect a refetch rather than a replay.
consoleReadRoutes.openapi(
  createRoute({
    method: "post",
    path: "/revisions-sync",
    tags: ["Consoles"],
    summary: "POST /revisions-sync",
    security: AUTH_SECURITY,
    request: { params: wsParams, body: looseJsonBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      if (!user) return accessDenied(c);

      const body = await c.req.json();
      const revisions = body?.revisions as Record<string, unknown> | undefined;
      if (!revisions || typeof revisions !== "object") {
        return fail(c, 400, "'revisions' object is required");
      }

      const { changed, deleted } = await syncConsoleRevisions({
        workspaceId: c.req.param("workspaceId") as string,
        userId: user.id,
        revisions,
      });
      return c.json({ success: true, changed, deleted });
    } catch (error) {
      return serverError(
        c,
        error,
        "Error syncing console revisions",
        "Unknown error syncing revisions",
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/consoles/search?q=...
consoleReadRoutes.openapi(
  createRoute({
    method: "get",
    path: "/search",
    tags: ["Consoles"],
    summary: "GET /search",
    security: AUTH_SECURITY,
    request: {
      params: wsParams,
      query: z.object({ q: queryParam("q"), limit: queryParam("limit") }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const query = c.req.query("q") || "";
      const limitParam = c.req.query("limit");
      const limit = limitParam ? Math.min(parseInt(limitParam, 10), 50) : 20;

      if (query.length < 2) {
        return c.json({ results: [] });
      }

      const { searchConsoles } =
        await import("../../agent-lib/tools/console-search-tools");
      const results = await searchConsoles(query, workspaceId, limit);

      return c.json({ results });
    } catch (err) {
      logger.error("Console search failed", { error: err });
      return fail(c, 500, "Search failed");
    }
  },
);

// GET /api/workspaces/:workspaceId/consoles/list - List all consoles (flat list for API clients)
consoleReadRoutes.openapi(
  createRoute({
    method: "get",
    path: "/list",
    tags: ["Consoles"],
    summary: "GET /list",
    security: AUTH_SECURITY,
    request: { params: wsParams },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const consoles = await listConsoleSummaries(
        c.req.param("workspaceId") as string,
        c.get("user")?.id,
      );
      return c.json({ success: true, consoles, total: consoles.length });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: true, consoles: [], total: 0 }, 200);
      }
      logger.error("Error listing consoles", { error });
      return fail(
        c,
        500,
        error instanceof Error ? error.message : "Failed to list consoles",
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/consoles/:id/executions - Recent query execution logs
consoleReadRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/executions",
    tags: ["Consoles"],
    summary: "GET /{id}/executions",
    security: AUTH_SECURITY,
    request: {
      params: consoleIdParams,
      query: z.object({ limit: queryParam("limit") }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const consoleId = c.req.param("id") as string;
      if (!Types.ObjectId.isValid(consoleId)) {
        return fail(c, 400, "Invalid console ID");
      }

      const limitParam = c.req.query("limit");
      const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 10;
      const executions = await consoleExecutions({
        workspaceId: c.req.param("workspaceId") as string,
        consoleId,
        userId: c.get("user")?.id,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : 10,
      });
      if (!executions) return fail(c, 404, "Console not found");
      return c.json({ success: true, executions });
    } catch (error) {
      return serverError(
        c,
        error,
        "Error listing console executions",
        "Failed to list console executions",
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/consoles/:id/details - Get console details (for API clients)
consoleReadRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/details",
    tags: ["Consoles"],
    summary: "GET /{id}/details",
    security: AUTH_SECURITY,
    request: { params: consoleIdParams },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const consoleId = c.req.param("id") as string;
      if (!Types.ObjectId.isValid(consoleId)) {
        return fail(c, 400, "Invalid console ID");
      }

      const details = await consoleDetails({
        workspaceId: c.req.param("workspaceId") as string,
        consoleId,
        userId: c.get("user")?.id,
        memberRole: c.get("memberRole"),
        viaApiKey: isApiKeyAuth(c),
      });
      if (!details) return fail(c, 404, "Console not found");
      return c.json({ success: true, console: details });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return fail(c, 404, "Console not found");
      }
      logger.error("Error getting console details", { error });
      return fail(
        c,
        500,
        error instanceof Error
          ? error.message
          : "Failed to get console details",
      );
    }
  },
);
