/**
 * A console's schedule (workspace admins only — the parent router gates
 * `/:id/schedule` and below): set, clear, run now, list runs.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  queryParam,
} from "../../openapi/core";
import {
  clearConsoleSchedule,
  listScheduledRuns,
  setConsoleSchedule,
  triggerConsoleRun,
} from "../../services/consoles/schedule";
import { fail } from "../lib/respond";
import { consoleIdParams, looseJsonBody, serverError } from "./shared";

export const consoleScheduleRoutes = createRouter();

consoleScheduleRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/schedule",
    tags: ["Consoles"],
    summary: "PUT /{id}/schedule",
    security: AUTH_SECURITY,
    request: { params: consoleIdParams, body: looseJsonBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const consoleId = c.req.param("id") as string;
      const body = await c.req.json();
      if (!Types.ObjectId.isValid(consoleId)) {
        return fail(c, 400, "Invalid console ID");
      }

      const scheduled = await setConsoleSchedule({
        workspaceId: c.req.param("workspaceId") as string,
        consoleId,
        cron: body?.cron,
        timezone: body?.timezone,
        actorUserId: c.get("user")?.id,
      });
      if (!scheduled) return fail(c, 404, "Console not found");
      return c.json({ success: true, ...scheduled });
    } catch (error) {
      return serverError(
        c,
        error,
        "Error updating console schedule",
        "Failed to update console schedule",
      );
    }
  },
);

consoleScheduleRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/schedule",
    tags: ["Consoles"],
    summary: "DELETE /{id}/schedule",
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

      const cleared = await clearConsoleSchedule({
        workspaceId: c.req.param("workspaceId") as string,
        consoleId,
        actorUserId: c.get("user")?.id,
      });
      if (!cleared) return fail(c, 404, "Console not found");
      return c.json({ success: true });
    } catch (error) {
      return serverError(
        c,
        error,
        "Error removing console schedule",
        "Failed to remove console schedule",
      );
    }
  },
);

consoleScheduleRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/schedule/run",
    tags: ["Consoles"],
    summary: "POST /{id}/schedule/run",
    security: AUTH_SECURITY,
    request: { params: consoleIdParams, body: looseJsonBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const consoleId = c.req.param("id") as string;
      if (!Types.ObjectId.isValid(consoleId)) {
        return fail(c, 400, "Invalid console ID");
      }

      const eventId = await triggerConsoleRun({
        workspaceId: c.req.param("workspaceId") as string,
        consoleId,
        triggeredBy: c.get("user")?.id,
      });
      if (!eventId) return fail(c, 404, "Console not found");
      return c.json({ success: true, eventId });
    } catch (error) {
      return serverError(
        c,
        error,
        "Error triggering scheduled console run",
        "Failed to trigger scheduled query run",
      );
    }
  },
);

consoleScheduleRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/schedule/runs",
    tags: ["Consoles"],
    summary: "List scheduled query runs",
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
      const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
      if (!Types.ObjectId.isValid(consoleId)) {
        return fail(c, 400, "Invalid console ID");
      }

      const { scheduledRun, runs } = await listScheduledRuns({
        workspaceId: c.req.param("workspaceId") as string,
        consoleId,
        limit,
      });
      return c.json({ success: true, scheduledRun, runs });
    } catch (error) {
      return serverError(
        c,
        error,
        "Error listing scheduled console runs",
        "Failed to list scheduled query runs",
      );
    }
  },
);
