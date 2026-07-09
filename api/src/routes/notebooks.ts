/**
 * Notebook CRUD routes (working-tree backed).
 *
 * `GET/POST/PATCH/DELETE /api/workspaces/:workspaceId/notebooks[/:id]` — the
 * document surface the app's notebook explorer + renderer use. Backed by the
 * filesystem working tree today; Git sync layers on top later. Distinct from
 * the singular `/notebook/read` data endpoint (that runs SQL, this manages the
 * document).
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
import { notebookWorkingTreeService } from "../notebooks/notebook-workingtree.service";
import type { NotebookBlock } from "../notebooks/types";
import { loggers } from "../logging";

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
  .object({ name: z.string().optional() })
  .openapi("CreateNotebookRequest");

const UpdateNotebookSchema = z
  .object({
    name: z.string().optional(),
    blocks: z.array(BlockSchema).optional(),
  })
  .openapi("UpdateNotebookRequest");

function workspaceId(c: { get: (k: "workspace") => { _id: unknown } }): string {
  return String(c.get("workspace")._id);
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
    const data = await notebookWorkingTreeService.list(workspaceId(c));
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
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const doc = await notebookWorkingTreeService.create(workspaceId(c), {
      name: body.name,
    });
    logger.info("Created notebook", {
      workspaceId: workspaceId(c),
      notebookId: doc.id,
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
    const doc = await notebookWorkingTreeService.get(
      workspaceId(c),
      c.req.valid("param").id,
    );
    if (!doc)
      return c.json({ success: false, error: "Notebook not found" }, 404);
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
    };
    const doc = await notebookWorkingTreeService.update(
      workspaceId(c),
      c.req.valid("param").id,
      body,
    );
    if (!doc)
      return c.json({ success: false, error: "Notebook not found" }, 404);
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
    const ok = await notebookWorkingTreeService.remove(
      workspaceId(c),
      c.req.valid("param").id,
    );
    if (!ok)
      return c.json({ success: false, error: "Notebook not found" }, 404);
    return c.json({ success: true });
  },
);
