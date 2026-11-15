/**
 * A console's versions. Git is the history — the same surface apps expose
 * (apps.md §16): commits that touched the console's file, what one commit
 * changed, a file before/after a commit, and restore-as-new-commit. Read
 * from the repo; no sandbox. Plus the AI-suggested comment for a save.
 *
 * The paths predate `lib/git-history-routes.ts` (history and restore sit
 * directly under `/{id}`, and `path` is optional on file-versions), so
 * consoles keep their own four routes rather than change the contract.
 */
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { Types } from "mongoose";
import {
  SavedConsole,
  type ISavedConsole,
} from "../../database/workspace-schema";
import {
  consoleCommitChanges,
  consoleFileVersions,
  consoleHistory,
  requestConsoleDescription,
  restoreConsoleTo,
} from "../../apps/workspace-consoles.service";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  jsonBody,
} from "../../openapi/core";
import { canReadConsole, canWriteConsole } from "../../services/consoles";
import {
  VERSION_COMMENT_MAX_CHARS,
  consoleVersionComment,
} from "../../services/consoles/version-comment";
import { publishRealtimeEvent } from "../../services/realtime.service";
import { fail } from "../lib/respond";
import {
  accessDenied,
  consoleIdParams,
  logger,
  looseJsonBody,
  repoRequired,
  serverError,
} from "./shared";
import { RepoRequiredError } from "../../apps/config";

export const consoleHistoryRoutes = createRouter();

const Sha = z.string().regex(/^[0-9a-f]{7,40}$/);

// POST /api/workspaces/:workspaceId/consoles/:id/version-comment - Generate AI version comment
consoleHistoryRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/version-comment",
    tags: ["Consoles"],
    summary: "POST /{id}/version-comment",
    security: AUTH_SECURITY,
    request: { params: consoleIdParams, body: looseJsonBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      if (!user) return accessDenied(c);

      const { newContent, source, aiPrompt } = await c.req.json();
      if (typeof newContent !== "string") {
        return fail(c, 400, "newContent must be a string");
      }
      if (newContent.length > VERSION_COMMENT_MAX_CHARS) {
        return fail(c, 400, "Content too large for comment generation");
      }

      const generated = await consoleVersionComment({
        workspaceId: c.req.param("workspaceId") as string,
        consoleId: c.req.param("id") as string,
        newContent,
        source,
        aiPrompt,
        user,
        memberRole: c.get("memberRole") as string | undefined,
      });
      // Null: the console exists and the caller cannot read it.
      if (!generated) return fail(c, 404, "Console not found");
      return c.json({ success: true, ...generated });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error generating version comment", { error });
      return fail(c, 500, "Failed to generate version comment");
    }
  },
);

/** The console the history routes act on, readable (and writable) by the caller. */
async function loadReadableConsole(
  c: Context,
  opts: { write: boolean },
): Promise<
  { doc: ISavedConsole; userId: string; workspaceId: string } | Response
> {
  const workspaceId = c.req.param("workspaceId") as string;
  const consoleId = c.req.param("id") as string;
  const user = c.get("user") as { id: string } | undefined;
  if (!user) return accessDenied(c);
  if (!Types.ObjectId.isValid(consoleId)) {
    return fail(c, 400, "Invalid console ID");
  }
  const doc = await SavedConsole.findOne({
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  const memberRole = c.get("memberRole") as string | undefined;
  if (!doc || !canReadConsole(doc, user.id, memberRole)) {
    return fail(c, 404, "Console not found");
  }
  if (opts.write && !canWriteConsole(doc, user.id, memberRole)) {
    return fail(c, 403, "You do not have write access");
  }
  return { doc, userId: user.id, workspaceId };
}

consoleHistoryRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/history",
    tags: ["Consoles"],
    summary: "Commit history of a console (its file in the workspace repo)",
    security: AUTH_SECURITY,
    request: {
      params: consoleIdParams,
      query: z.object({
        limit: z.coerce.number().int().positive().max(200).optional(),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const loaded = await loadReadableConsole(c, { write: false });
      if (loaded instanceof Response) return loaded;
      const { limit } = c.req.valid("query");
      const commits = await consoleHistory(loaded.doc, limit ?? 50);
      return c.json({
        success: true as const,
        commits,
        path: loaded.doc.path ?? null,
      });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error listing console history", { error });
      return fail(c, 500, "Failed to list history");
    }
  },
);

consoleHistoryRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/git/commit",
    tags: ["Consoles"],
    summary: "What one commit changed for this console",
    security: AUTH_SECURITY,
    request: { params: consoleIdParams, query: z.object({ sha: Sha }) },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const loaded = await loadReadableConsole(c, { write: false });
      if (loaded instanceof Response) return loaded;
      const { sha } = c.req.valid("query");
      const commit = await consoleCommitChanges(loaded.doc, sha);
      return c.json({ success: true as const, commit });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error reading console commit", { error });
      return fail(c, 500, "Failed to read the commit");
    }
  },
);

consoleHistoryRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/git/file-versions",
    tags: ["Consoles"],
    summary: "A console file before and after one commit (for diffs)",
    security: AUTH_SECURITY,
    request: {
      params: consoleIdParams,
      query: z.object({
        sha: Sha,
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            p => !p.startsWith("/") && !p.split("/").includes(".."),
            "path must stay inside the repository",
          )
          .optional(),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const loaded = await loadReadableConsole(c, { write: false });
      if (loaded instanceof Response) return loaded;
      const { sha, path: relPath } = c.req.valid("query");
      const target = relPath ?? loaded.doc.path;
      if (!target) return fail(c, 404, "Console has no file yet");
      // Only this console's own file (and its chart) may be read through it.
      const own = new Set([
        loaded.doc.path,
        loaded.doc.path
          ? `${loaded.doc.path.replace(/\.[^./]+(\.js)?$/, "")}.chart.json`
          : undefined,
      ]);
      if (!own.has(target)) return fail(c, 403, "Path is not this console");
      const versions = await consoleFileVersions(loaded.doc, sha, target);
      return c.json({ success: true as const, versions });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error reading console file versions", { error });
      return fail(c, 500, "Failed to read the diff");
    }
  },
);

consoleHistoryRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Consoles"],
    summary: "Restore the console to a previous commit (as a new commit)",
    description:
      "Sets the console back to its content at `sha` and commits that on main. Nothing is rewritten: the versions in between stay in the history.",
    security: AUTH_SECURITY,
    request: {
      params: consoleIdParams,
      body: jsonBody(z.object({ sha: Sha })),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const loaded = await loadReadableConsole(c, { write: true });
      if (loaded instanceof Response) return loaded;
      const { sha } = c.req.valid("json");
      const result = await restoreConsoleTo(loaded.doc, sha, loaded.userId);
      publishRealtimeEvent(loaded.workspaceId, {
        type: "console.updated",
        consoleId: loaded.doc._id.toString(),
        draftRevision: loaded.doc.draftRevision ?? 1,
        name: loaded.doc.name,
        updatedBy: loaded.userId,
        origin: "save",
      });
      requestConsoleDescription({
        workspaceId: loaded.workspaceId,
        consoleId: loaded.doc._id.toString(),
        tracking: { userId: loaded.userId },
      });
      return c.json({ success: true as const, result });
    } catch (error) {
      return serverError(c, error, "Error restoring console", "Restore failed");
    }
  },
);
