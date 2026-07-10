/**
 * Notebook kernel session + execution routes.
 *
 * `POST /{id}/sessions`         start (or return) the notebook's kernel session
 * `GET  /{id}/sessions/current` current session status (404 if none)
 * `DELETE /{id}/sessions/current` stop the kernel
 * `POST /{id}/executions`       run code on the kernel, streaming outputs (SSE)
 *
 * These sit alongside the CRUD routes under
 * `/api/workspaces/:workspaceId/notebooks`. Execution streams each rendered
 * kernel output as an SSE event; the run continues server-side (FIFO queue) if
 * the client disconnects. Resumable-stream reattach is the next hardening step.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";

import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { requireWorkspace } from "../middleware/workspace.middleware";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  jsonBody,
  pathParam,
} from "../openapi/core";
import {
  KernelUnavailableError,
  kernelSessionService,
} from "../services/kernel-session.service";
import { loggers } from "../logging";

const logger = loggers.api("notebook-sessions");

export const notebookSessionRoutes = createRouter();

const wsIdParams = z.object({
  workspaceId: pathParam("workspaceId"),
  id: pathParam("id"),
});

const ExecuteSchema = z
  .object({ code: z.string(), blockId: z.string().optional() })
  .openapi("NotebookExecuteRequest");

function workspaceId(c: { get: (k: "workspace") => { _id: unknown } }): string {
  return String(c.get("workspace")._id);
}

function userId(c: {
  get: (k: "user") => { id?: unknown } | undefined;
}): string {
  return String(c.get("user")?.id ?? "system");
}

// POST /{id}/sessions — start (idempotent) the notebook's kernel session
notebookSessionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/sessions",
    tags: ["Notebooks"],
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: wsIdParams },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const session = await kernelSessionService.start({
        workspaceId: workspaceId(c),
        notebookId: c.req.valid("param").id,
        userId: userId(c),
      });
      return c.json({ success: true, data: session });
    } catch (error) {
      if (error instanceof KernelUnavailableError) {
        return c.json({ success: false, error: error.message }, 503);
      }
      logger.error("failed to start kernel session", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Failed to start kernel",
        },
        500,
      );
    }
  },
);

// GET /{id}/sessions/current — current session status
notebookSessionRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/sessions/current",
    tags: ["Notebooks"],
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: wsIdParams },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const session = kernelSessionService.get(
      workspaceId(c),
      c.req.valid("param").id,
    );
    if (!session) return c.json({ success: false, error: "No session" }, 404);
    return c.json({ success: true, data: session });
  },
);

// DELETE /{id}/sessions/current — stop the kernel
notebookSessionRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/sessions/current",
    tags: ["Notebooks"],
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: wsIdParams },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const stopped = await kernelSessionService.stop(
      workspaceId(c),
      c.req.valid("param").id,
    );
    return c.json({ success: true, data: { stopped } });
  },
);

// POST /{id}/executions — run code on the kernel, stream outputs as SSE
notebookSessionRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/executions",
    tags: ["Notebooks"],
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: wsIdParams, body: jsonBody(ExecuteSchema) },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const wsId = workspaceId(c);
    const notebookId = c.req.valid("param").id;
    const { code } = (await c.req.json().catch(() => ({ code: "" }))) as {
      code: string;
    };

    return streamSSE(c, async stream => {
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) });
      try {
        const result = await kernelSessionService.execute(
          wsId,
          notebookId,
          code,
          output => void send(output.type, output),
          { signal: c.req.raw.signal },
        );
        await send("done", result);
      } catch (error) {
        const message =
          error instanceof KernelUnavailableError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Execution failed";
        await send("failed", { message });
      }
    });
  },
);
