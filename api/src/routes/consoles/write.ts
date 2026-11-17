/**
 * Writing consoles: create, save (explicit or draft autosave, by id or by
 * path), rename, delete, duplicate, restore from soft delete. Session users
 * only; every write commits to the workspace repo first.
 */
import { createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { Types } from "mongoose";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { duplicateConsole, restoreConsole } from "../../services/consoles";
import {
  deleteConsoleAs,
  renameConsoleAs,
} from "../../services/consoles/lifecycle";
import {
  createConsoleAtPath,
  saveConsoleById,
  saveConsoleByPath,
  type ConsoleSaveBody,
} from "../../services/consoles/save";
import { fail } from "../lib/respond";
import {
  accessDenied,
  consoleIdParams,
  looseJsonBody,
  serverError,
  wsParams,
} from "./shared";

export const consoleWriteRoutes = createRouter();

// POST /api/workspaces/:workspaceId/consoles - Create new console
consoleWriteRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Consoles"],
    summary: "POST /",
    security: AUTH_SECURITY,
    request: { params: wsParams, body: looseJsonBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const body = await c.req.json();
      const user = c.get("user");
      if (!user) return accessDenied(c);

      const { path: consolePath, content } = body;
      if (!consolePath || typeof consolePath !== "string") {
        return fail(c, 400, "Path is required and must be a string");
      }
      if (typeof content !== "string") {
        return fail(c, 400, "Content must be a string");
      }

      const created = await createConsoleAtPath({
        workspaceId: c.req.param("workspaceId") as string,
        user,
        id: body.id,
        path: consolePath,
        content,
        connectionId: body.connectionId,
        databaseId: body.databaseId,
        databaseName: body.databaseName,
        folderId: body.folderId,
        description: body.description,
        language: body.language,
        isPrivate: body.isPrivate,
        access: body.access,
        chartSpec: body.chartSpec,
        resultsViewMode: body.resultsViewMode,
      });
      if (!created.ok) {
        return fail(c, created.status, created.error, created.detail);
      }
      return c.json(
        {
          success: true,
          message: "Console created successfully",
          data: created.payload,
        },
        201,
      );
    } catch (error) {
      return serverError(
        c,
        error,
        "Error creating console",
        "Unknown error creating console",
      );
    }
  },
);

// PUT /api/workspaces/:workspaceId/consoles/:pathOrId - Update/upsert console
// If pathOrId is a valid ObjectId, upserts by ID (used for auto-save)
// Otherwise, saves by path (used for explicit user save to folder)
consoleWriteRoutes.put("/:path{.+}", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId") as string;
    const pathOrId = c.req.param("path") as string;
    const body = (await c.req.json()) as ConsoleSaveBody;
    const user = c.get("user") as { id: string; email?: string } | undefined;
    if (!user) return accessDenied(c);

    if (typeof body.content !== "string") {
      return fail(c, 400, "Content is required and must be a string");
    }

    if (Types.ObjectId.isValid(pathOrId) && pathOrId.length === 24) {
      const saved = await saveConsoleById({
        workspaceId,
        consoleId: pathOrId,
        user,
        memberRole: c.get("memberRole") as string | undefined,
        body,
      });
      if (!saved.ok) return fail(c, saved.status, saved.error, saved.detail);
      return c.json({
        success: true,
        message: "Console saved",
        ...saved.payload,
      });
    }

    const saved = await saveConsoleByPath({
      workspaceId,
      user,
      path: pathOrId,
      body,
    });
    if (!saved.ok) return fail(c, saved.status, saved.error, saved.detail);
    return c.json({
      success: true,
      message: "Console updated successfully",
      data: saved.payload,
    });
  } catch (error) {
    return serverError(
      c,
      error,
      "Error updating console",
      "Unknown error updating console",
      { path: c.req.param("path") },
    );
  }
});

// PATCH /api/workspaces/:workspaceId/consoles/:id/rename - Rename a console
consoleWriteRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/rename",
    tags: ["Consoles"],
    summary: "PATCH /{id}/rename",
    security: AUTH_SECURITY,
    request: { params: consoleIdParams, body: looseJsonBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const body = await c.req.json();
      const user = c.get("user");
      if (!user) return accessDenied(c);

      const renamed = await renameConsoleAs({
        workspaceId: c.req.param("workspaceId") as string,
        consoleId: c.req.param("id") as string,
        name: body.name,
        userId: user.id,
        memberRole: c.get("memberRole"),
      });
      if (!renamed.ok) return fail(c, renamed.status, renamed.error);
      return c.json({ success: true, message: "Console renamed successfully" });
    } catch (error) {
      return serverError(
        c,
        error,
        "Error renaming console",
        "Unknown error renaming console",
        { consoleId: c.req.param("id") },
      );
    }
  },
);

// DELETE /api/workspaces/:workspaceId/consoles/:id - Soft-delete a console
consoleWriteRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Consoles"],
    summary: "DELETE /{id}",
    security: AUTH_SECURITY,
    request: { params: consoleIdParams },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const consoleId = c.req.param("id") as string;
      const user = c.get("user");
      if (!user) return accessDenied(c);

      const deleted = await deleteConsoleAs({
        workspaceId: c.req.param("workspaceId") as string,
        consoleId,
        userId: user.id,
        memberRole: c.get("memberRole"),
      });
      if (!deleted.ok) return fail(c, deleted.status, deleted.error);
      return c.json({
        success: true,
        message: "Console deleted successfully",
        id: consoleId,
      });
    } catch (error) {
      return serverError(
        c,
        error,
        "Error deleting console",
        "Unknown error deleting console",
        { consoleId: c.req.param("id") },
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/consoles/:id/duplicate - Duplicate a console
consoleWriteRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/duplicate",
    tags: ["Consoles"],
    summary: "POST /{id}/duplicate",
    security: AUTH_SECURITY,
    request: { params: consoleIdParams, body: looseJsonBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      if (!user) return accessDenied(c);

      const copy = await duplicateConsole(
        c.req.param("id") as string,
        c.req.param("workspaceId") as string,
        user.id,
      );
      if (!copy) return fail(c, 404, "Console not found");
      return c.json(
        {
          success: true,
          message: "Console duplicated",
          data: {
            id: copy._id.toString(),
            name: copy.name,
            folderId: copy.folderId?.toString(),
          },
        },
        201,
      );
    } catch (error) {
      return serverError(
        c,
        error,
        "Error duplicating console",
        "Unknown error duplicating console",
        { consoleId: c.req.param("id") },
      );
    }
  },
);

// PATCH /api/workspaces/:workspaceId/consoles/:id/restore - Restore a soft-deleted console
consoleWriteRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/restore",
    tags: ["Consoles"],
    summary: "PATCH /{id}/restore",
    security: AUTH_SECURITY,
    request: { params: consoleIdParams, body: looseJsonBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      if (!user) return accessDenied(c);

      const restored = await restoreConsole(
        c.req.param("id") as string,
        c.req.param("workspaceId") as string,
        user.id,
        c.get("memberRole") as string | undefined,
      );
      if (!restored) return fail(c, 404, "Console not found");
      return c.json({ success: true, message: "Console restored" });
    } catch (error) {
      return serverError(
        c,
        error,
        "Error restoring console",
        "Unknown error restoring console",
        { consoleId: c.req.param("id") },
      );
    }
  },
);
