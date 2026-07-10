/**
 * Notebook CRUD routes.
 *
 * `GET/POST/PATCH/DELETE /api/workspaces/:workspaceId/notebooks[/:id]` — the
 * document surface the app's notebook explorer + renderer use. Backed by the
 * durable notebook store (GCS objects in deployed envs, filesystem locally);
 * GitHub sync can layer on later. Distinct from the singular `/notebook/read`
 * data endpoint (that runs SQL, this manages the document).
 */
import { createRoute, z } from "@hono/zod-openapi";

import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { requireWorkspace } from "../middleware/workspace.middleware";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  jsonBody,
  pathParam,
} from "../openapi/core";
import { getNotebookStore } from "../notebooks/store";
import type { NotebookBlock } from "../notebooks/types";
import { loggers } from "../logging";
import { publishRealtimeEvent } from "../services/realtime.service";

const logger = loggers.api("notebooks");

export const notebookRoutes = createRouter();

const wsParams = z.object({ workspaceId: pathParam("workspaceId") });
const wsIdParams = z.object({
  workspaceId: pathParam("workspaceId"),
  id: pathParam("id"),
});

const BlockSchema = z.object({
  id: z.string(),
  type: z.enum(["code", "sql", "markdown"]),
  source: z.string(),
  connectionId: z.string().optional(),
});

const CreateNotebookSchema = z
  .object({ name: z.string().optional(), clientId: z.string().optional() })
  .openapi("CreateNotebookRequest");

const UpdateNotebookSchema = z
  .object({
    name: z.string().optional(),
    blocks: z.array(BlockSchema).optional(),
    clientId: z.string().optional(),
  })
  .openapi("UpdateNotebookRequest");

function workspaceId(c: { get: (k: "workspace") => { _id: unknown } }): string {
  return String(c.get("workspace")._id);
}

function editorUserId(c: {
  get: (k: "user") => { id?: unknown } | undefined;
}): string {
  return String(c.get("user")?.id ?? "system");
}

// GET / — list notebooks
notebookRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Notebooks"],
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: wsParams },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const data = await getNotebookStore().list(workspaceId(c));
    return c.json({ success: true, data });
  },
);

// POST / — create a notebook
notebookRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Notebooks"],
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: wsParams, body: jsonBody(CreateNotebookSchema, true) },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      clientId?: string;
    };
    const doc = await getNotebookStore().create(workspaceId(c), {
      name: body.name,
    });
    logger.info("Created notebook", {
      workspaceId: workspaceId(c),
      notebookId: doc.id,
    });
    // Poke other clients so their explorer list picks up the new notebook.
    publishRealtimeEvent(workspaceId(c), {
      type: "notebook.updated",
      notebookId: doc.id,
      version: doc.version,
      updatedBy: editorUserId(c),
      clientId: typeof body.clientId === "string" ? body.clientId : undefined,
      origin: "save",
    });
    return c.json({ success: true, data: doc }, 201);
  },
);

// GET /:id — fetch a notebook
notebookRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Notebooks"],
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: wsIdParams },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const doc = await getNotebookStore().get(
      workspaceId(c),
      c.req.valid("param").id,
    );
    if (!doc) {
      return c.json({ success: false, error: "Notebook not found" }, 404);
    }
    return c.json({ success: true, data: doc });
  },
);

// PATCH /:id — rename and/or replace blocks
notebookRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Notebooks"],
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: wsIdParams, body: jsonBody(UpdateNotebookSchema) },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      blocks?: NotebookBlock[];
      clientId?: string;
    };
    const doc = await getNotebookStore().update(
      workspaceId(c),
      c.req.valid("param").id,
      body,
    );
    if (!doc) {
      return c.json({ success: false, error: "Notebook not found" }, 404);
    }
    // Poke open tabs on other clients to pull the updated notebook.
    publishRealtimeEvent(workspaceId(c), {
      type: "notebook.updated",
      notebookId: doc.id,
      version: doc.version,
      updatedBy: editorUserId(c),
      clientId: typeof body.clientId === "string" ? body.clientId : undefined,
      origin: "save",
    });
    return c.json({ success: true, data: doc });
  },
);

// DELETE /:id
notebookRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Notebooks"],
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: wsIdParams },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const ok = await getNotebookStore().remove(
      workspaceId(c),
      c.req.valid("param").id,
    );
    if (!ok) {
      return c.json({ success: false, error: "Notebook not found" }, 404);
    }
    return c.json({ success: true });
  },
);
