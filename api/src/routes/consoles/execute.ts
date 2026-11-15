/**
 * Running a saved console (POST /{id}/execute) and exporting its results
 * (GET /{id}/export). API keys run with their scopes and their owner's role
 * (set by the parent router); viewers only read.
 */
import { createRoute } from "@hono/zod-openapi";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import {
  executeConsoleRequest,
  exportConsoleResults,
  type ExportFormat,
} from "../../services/consoles/execute";
import { fail } from "../lib/respond";
import { consoleIdParams, looseJsonBody, serverError } from "./shared";

export const consoleExecuteRoutes = createRouter();

// POST /api/workspaces/:workspaceId/consoles/:id/execute - Execute a saved console
consoleExecuteRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/execute",
    tags: ["Consoles"],
    summary: "POST /{id}/execute",
    security: AUTH_SECURITY,
    request: { params: consoleIdParams, body: looseJsonBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const outcome = await executeConsoleRequest({
        // Access was verified by the router middleware; only the id is needed.
        workspaceId: c.req.param("workspaceId") as string,
        consoleId: c.req.param("id") as string,
        userId: c.get("user")?.id,
        apiKey: c.get("apiKey"),
        memberRole: c.get("memberRole"),
        mode: c.req.query("mode"),
        pageSize: c.req.query("pageSize"),
        cursor: c.req.query("cursor"),
      });
      if (!outcome.ok) return fail(c, outcome.status, outcome.error);
      return c.json(outcome.body);
    } catch (error) {
      return serverError(
        c,
        error,
        "Error executing console",
        "Failed to execute console",
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/consoles/:id/export - Export console query results as Arrow IPC or JSON
consoleExecuteRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/export",
    tags: ["Consoles"],
    summary: "GET /{id}/export",
    security: AUTH_SECURITY,
    request: { params: consoleIdParams },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const exported = await exportConsoleResults({
        workspaceId: c.req.param("workspaceId") as string,
        consoleId: c.req.param("id") as string,
        userId: c.get("user")?.id,
        format: (c.req.query("format") || "arrow") as ExportFormat,
        limit: parseInt(c.req.query("limit") || "500000", 10),
        signal: c.req.raw.signal,
      });
      if (!exported.ok) return fail(c, exported.status, exported.error);
      if ("json" in exported) return c.json(exported.json);
      return exported.response;
    } catch (error) {
      return serverError(
        c,
        error,
        "Error exporting console data",
        "Export failed",
      );
    }
  },
);
