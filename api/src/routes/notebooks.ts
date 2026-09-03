/**
 * Notebook CRUD routes.
 *
 * `GET/POST/PATCH/DELETE /api/workspaces/:workspaceId/notebooks[/:id]` — the
 * document surface the app's notebook explorer + renderer use. Notebook bodies
 * live in object storage (GCS/filesystem); organization + ACL use Mongo
 * (`NotebookFolder`, `NotebookIndex`).
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";

import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import {
  requireWorkspace,
  type AuthenticatedContext,
} from "../middleware/workspace.middleware";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  jsonBody,
  pathParam,
} from "../openapi/core";
import {
  NotebookFolder,
  NotebookIndex,
  type INotebookIndex,
} from "../database/workspace-schema";
import {
  createModelFolderBackend,
  registerFolderRoutes,
} from "./lib/folder-routes";
import {} from "./lib/version-routes";
import { getNotebookStore } from "../notebooks/store";
import { NotebookVersionConflictError } from "../notebooks/store/types";
import { offloadBlocks } from "../notebooks/offload";
import type { NotebookBlock } from "../notebooks/types";
import { loggers } from "../logging";
import { publishRealtimeEvent } from "../services/realtime.service";
import { RepoRequiredError } from "../apps/config";
import {
  notebookCommitChanges,
  notebookFileVersions,
  notebookHistory,
  removeNotebookFile,
  restoreNotebookTo,
  scheduleNotebookCheckpoint,
} from "../notebooks/notebook-git.service";
import {
  createNotebookIndex,
  deleteNotebookIndex,
  getNotebookIndex,
  updateNotebookIndex,
} from "../services/notebook-index.service";
import { NotebookManager } from "../utils/notebook-manager";

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
  outputs: z.array(z.unknown()).optional(),
  executionCount: z.number().optional(),
  executedAt: z.string().optional(),
});

const CreateNotebookSchema = z
  .object({
    name: z.string().optional(),
    clientId: z.string().optional(),
    folderId: z.string().nullable().optional(),
    access: z.enum(["private", "workspace"]).optional(),
  })
  .openapi("CreateNotebookRequest");

const UpdateNotebookSchema = z
  .object({
    name: z.string().optional(),
    blocks: z.array(BlockSchema).optional(),
    clientId: z.string().optional(),
    expectedVersion: z.number().int().positive().optional(),
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

function memberRole(c: {
  get: (k: "memberRole") => string | undefined;
}): string {
  return c.get("memberRole") ?? "member";
}

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

async function requireNotebookAccess(
  workspaceIdStr: string,
  notebookId: string,
  userId: string,
  role: string,
  mode: "read" | "write",
): Promise<
  | {
      ok: true;
      index: NonNullable<Awaited<ReturnType<typeof getNotebookIndex>>>;
    }
  | { ok: false; status: 403 | 404 }
> {
  const index = await getNotebookIndex(workspaceIdStr, notebookId);
  if (!index) return { ok: false, status: 404 };

  const effectiveAccess = await NotebookManager.getEffectiveAccessForNotebook(
    index,
    workspaceIdStr,
  );
  const allowed =
    mode === "read"
      ? NotebookManager.canRead(index, userId, role, effectiveAccess)
      : NotebookManager.canWrite(
          index,
          userId,
          isAdminRole(role),
          role,
          effectiveAccess,
        );

  if (!allowed) return { ok: false, status: mode === "read" ? 404 : 403 };
  return { ok: true, index };
}

function publishTreeUpdated(workspaceIdStr: string): void {
  publishRealtimeEvent(workspaceIdStr, { type: "notebook.tree.updated" });
}

// GET / — list notebooks as My / Workspace trees
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
    const userId = editorUserId(c);
    const data = await NotebookManager.listNotebooksSplit(
      workspaceId(c),
      userId,
      memberRole(c),
    );
    return c.json({ success: true, ...data });
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
      folderId?: string | null;
      access?: "private" | "workspace";
    };
    const ws = workspaceId(c);
    const userId = editorUserId(c);

    if (body.folderId && !Types.ObjectId.isValid(body.folderId)) {
      return c.json({ success: false, error: "Invalid folderId" }, 400);
    }

    const doc = await getNotebookStore().create(ws, { name: body.name });
    await createNotebookIndex({
      workspaceId: ws,
      notebookId: doc.id,
      name: doc.name,
      ownerId: userId,
      access: body.access ?? "private",
      folderId: body.folderId ?? null,
      updatedAt: new Date(doc.updatedAt),
    });

    logger.info("Created notebook", { workspaceId: ws, notebookId: doc.id });
    scheduleNotebookCheckpoint(ws, doc.id, userId);
    publishRealtimeEvent(ws, {
      type: "notebook.updated",
      notebookId: doc.id,
      version: doc.version,
      updatedBy: userId,
      clientId: typeof body.clientId === "string" ? body.clientId : undefined,
      origin: "save",
    });
    publishTreeUpdated(ws);
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
    const ws = workspaceId(c);
    const id = c.req.valid("param").id;
    const access = await requireNotebookAccess(
      ws,
      id,
      editorUserId(c),
      memberRole(c),
      "read",
    );
    if (!access.ok) {
      return c.json(
        { success: false, error: "Notebook not found" },
        access.status,
      );
    }

    const doc = await getNotebookStore().get(ws, id);
    if (!doc) {
      return c.json({ success: false, error: "Notebook not found" }, 404);
    }
    return c.json({ success: true, data: doc });
  },
);

// GET /:id/artifacts/:artifactId — stream a large output offloaded to the store
notebookRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/artifacts/{artifactId}",
    tags: ["Notebooks"],
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: {
      params: z.object({
        workspaceId: pathParam("workspaceId"),
        id: pathParam("id"),
        artifactId: pathParam("artifactId"),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const ws = workspaceId(c);
    const { id, artifactId } = c.req.valid("param");
    const access = await requireNotebookAccess(
      ws,
      id,
      editorUserId(c),
      memberRole(c),
      "read",
    );
    if (!access.ok) {
      return c.json(
        { success: false, error: "Artifact not found" },
        access.status,
      );
    }

    const artifact = await getNotebookStore().getArtifact(ws, id, artifactId);
    if (!artifact) {
      return c.json({ success: false, error: "Artifact not found" }, 404);
    }
    return c.body(artifact.body, 200, {
      "Content-Type": artifact.contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  },
);

// ── Version history: git commits of the notebook's .deepnote file ──
// The SAME surface apps and consoles use (CommitRow + GitFileDiffView), so
// authors, messages and diffs come free (apps.md §24). The store's own
// object generations are no longer surfaced — they carried neither author
// nor message.

const NotebookHistoryParams = wsParams.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

async function loadReadableNotebook(
  c: AuthenticatedContext,
  mode: "read" | "write",
): Promise<
  | { index: INotebookIndex; workspaceId: string; userId: string }
  | { errorResponse: Response }
> {
  const ws = workspaceId(c);
  const id = c.req.param("id");
  const userId = editorUserId(c);
  const access = await requireNotebookAccess(
    ws,
    id,
    userId,
    memberRole(c) ?? "member",
    mode,
  );
  if (!access.ok) {
    return {
      errorResponse: c.json(
        { success: false, error: "Notebook not found" },
        access.status as 403 | 404,
      ),
    };
  }
  const index = await NotebookIndex.findOne({
    workspaceId: new Types.ObjectId(ws),
    notebookId: id,
  });
  if (!index) {
    return {
      errorResponse: c.json(
        { success: false, error: "Notebook not found" },
        404,
      ),
    };
  }
  return { index, workspaceId: ws, userId };
}

notebookRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/history",
    tags: ["Notebooks"],
    summary: "Commit history of a notebook (its .deepnote file in the repo)",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: {
      params: NotebookHistoryParams,
      query: z.object({
        limit: z.coerce.number().int().positive().max(200).optional(),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const loaded = await loadReadableNotebook(c, "read");
    if ("errorResponse" in loaded) return loaded.errorResponse;
    const { limit } = c.req.valid("query");
    const commits = await notebookHistory(loaded.index, limit ?? 50);
    return c.json({
      success: true as const,
      commits,
      path: loaded.index.path ?? null,
    });
  },
);

notebookRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/git/commit",
    tags: ["Notebooks"],
    summary: "What one commit changed for this notebook",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: {
      params: NotebookHistoryParams,
      query: z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/) }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const loaded = await loadReadableNotebook(c, "read");
    if ("errorResponse" in loaded) return loaded.errorResponse;
    const { sha } = c.req.valid("query");
    const commit = await notebookCommitChanges(loaded.index, sha);
    return c.json({ success: true as const, commit });
  },
);

notebookRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/git/file-versions",
    tags: ["Notebooks"],
    summary: "A notebook file before and after one commit (for diffs)",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: {
      params: NotebookHistoryParams,
      query: z.object({
        sha: z.string().regex(/^[0-9a-f]{7,40}$/),
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            p => !p.startsWith("/") && !p.split("/").includes(".."),
            "path must stay inside the repository",
          ),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const loaded = await loadReadableNotebook(c, "read");
    if ("errorResponse" in loaded) return loaded.errorResponse;
    const { sha, path: relPath } = c.req.valid("query");
    const versions = await notebookFileVersions(loaded.index, sha, relPath);
    return c.json({ success: true as const, versions });
  },
);

notebookRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Notebooks"],
    summary: "Restore a notebook to its content at a commit (as a new commit)",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: {
      params: NotebookHistoryParams,
      body: jsonBody(
        z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/) }),
        true,
      ),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const loaded = await loadReadableNotebook(c, "write");
    if ("errorResponse" in loaded) return loaded.errorResponse;
    const { sha } = (await c.req.json()) as { sha: string };
    try {
      const result = await restoreNotebookTo(
        loaded.workspaceId,
        loaded.index.notebookId,
        sha,
        loaded.userId,
      );
      publishTreeUpdated(loaded.workspaceId);
      return c.json({ success: true as const, ...result });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json(
          { success: false, code: error.code, error: error.message },
          error.status as 412,
        );
      }
      logger.error("Notebook restore failed", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Restore failed",
        },
        400,
      );
    }
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
      expectedVersion?: number;
    };
    const store = getNotebookStore();
    const ws = workspaceId(c);
    const id = c.req.valid("param").id;
    const access = await requireNotebookAccess(
      ws,
      id,
      editorUserId(c),
      memberRole(c),
      "write",
    );
    if (!access.ok) {
      return c.json(
        { success: false, error: "Notebook not found" },
        access.status,
      );
    }

    const blocks = body.blocks
      ? await offloadBlocks(store, ws, id, body.blocks)
      : undefined;
    let doc;
    try {
      doc = await store.update(
        ws,
        id,
        { name: body.name, blocks },
        { expectedVersion: body.expectedVersion },
      );
    } catch (error) {
      if (error instanceof NotebookVersionConflictError) {
        return c.json(
          {
            success: false,
            error:
              "Notebook changed since it was loaded. Reload it before saving again.",
            code: "version_conflict",
            expectedVersion: error.expectedVersion,
            actualVersion: error.actualVersion,
          },
          409,
        );
      }
      throw error;
    }
    if (!doc) {
      return c.json({ success: false, error: "Notebook not found" }, 404);
    }

    if (body.name !== undefined) {
      await updateNotebookIndex(ws, id, {
        name: doc.name,
        updatedAt: new Date(doc.updatedAt),
      });
      publishTreeUpdated(ws);
    } else {
      await updateNotebookIndex(ws, id, {
        updatedAt: new Date(doc.updatedAt),
      });
    }

    publishRealtimeEvent(ws, {
      type: "notebook.updated",
      notebookId: doc.id,
      version: doc.version,
      updatedBy: editorUserId(c),
      clientId: typeof body.clientId === "string" ? body.clientId : undefined,
      origin: "save",
    });
    // Git checkpoint after the edit burst goes quiet (apps.md §24) — the
    // store above is the durable working copy; the commit is history.
    scheduleNotebookCheckpoint(ws, id, editorUserId(c));
    return c.json({ success: true, data: doc });
  },
);

// POST /:id/presence — ephemeral collaboration heartbeat
notebookRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/presence",
    tags: ["Notebooks"],
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: {
      params: wsIdParams,
      body: jsonBody(
        z
          .object({
            clientId: z.string(),
            activeCellId: z.string().nullable().optional(),
            gone: z.boolean().optional(),
          })
          .openapi("NotebookPresenceRequest"),
      ),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const ws = workspaceId(c);
    const id = c.req.valid("param").id;
    const access = await requireNotebookAccess(
      ws,
      id,
      editorUserId(c),
      memberRole(c),
      "read",
    );
    if (!access.ok) {
      return c.json(
        { success: false, error: "Notebook not found" },
        access.status,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      clientId?: string;
      activeCellId?: string | null;
      gone?: boolean;
    };
    if (!body.clientId) {
      return c.json({ success: false, error: "clientId is required" }, 400);
    }
    const user = c.get("user") as
      | { id?: unknown; email?: string; name?: string }
      | undefined;
    publishRealtimeEvent(ws, {
      type: "notebook.presence",
      notebookId: id,
      clientId: body.clientId,
      userId: String(user?.id ?? "anon"),
      userName: user?.name || user?.email || "Someone",
      activeCellId: body.activeCellId ?? null,
      gone: body.gone === true,
    });
    return c.json({ success: true });
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
    const ws = workspaceId(c);
    const id = c.req.valid("param").id;
    const access = await requireNotebookAccess(
      ws,
      id,
      editorUserId(c),
      memberRole(c),
      "write",
    );
    if (!access.ok) {
      return c.json(
        { success: false, error: "Notebook not found" },
        access.status,
      );
    }

    const doomedIndex = await NotebookIndex.findOne({
      workspaceId: new Types.ObjectId(ws),
      notebookId: id,
    }).select("path name");
    const ok = await getNotebookStore().remove(ws, id);
    if (!ok) {
      return c.json({ success: false, error: "Notebook not found" }, 404);
    }
    await deleteNotebookIndex(ws, id);
    if (doomedIndex) {
      await removeNotebookFile(ws, doomedIndex, editorUserId(c)).catch(
        () => undefined,
      );
    }
    publishTreeUpdated(ws);
    return c.json({ success: true });
  },
);

// ── Folder + move endpoints (shared registrar) ──

const notebookFolderBackend = createModelFolderBackend({
  folderModel: NotebookFolder,
  itemModel: NotebookIndex,
  // Moving a notebook (and optionally changing its access) goes through the
  // notebook index, which is the ACL + tree source of truth.
  moveItem: async (ctx, { itemId, folderId, access }) => {
    const access_ = await requireNotebookAccess(
      ctx.workspaceId,
      itemId,
      ctx.userId,
      ctx.role ?? "member",
      "write",
    );
    if (!access_.ok) {
      return { ok: false, status: access_.status, error: "Notebook not found" };
    }
    if (folderId) {
      const folder = await NotebookFolder.findOne({
        _id: new Types.ObjectId(folderId),
        workspaceId: new Types.ObjectId(ctx.workspaceId),
      });
      if (!folder) {
        return { ok: false, status: 404, error: "Folder not found" };
      }
    }
    // Access flips relocate the committed file (notebooks/ <-> users/…);
    // the next checkpoint reconciles the path.
    scheduleNotebookCheckpoint(ctx.workspaceId, itemId, ctx.userId);
    await updateNotebookIndex(ctx.workspaceId, itemId, {
      folderId: folderId ?? null,
      access,
    });
    return { ok: true };
  },
});

registerFolderRoutes(notebookRoutes, {
  tag: "Notebooks",
  schemaPrefix: "Notebook",
  middleware: [unifiedAuthMiddleware, requireWorkspace],
  actor: "allow-system",
  backend: notebookFolderBackend,
  afterChange: publishTreeUpdated,
});
