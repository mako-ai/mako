/** The dbt/ folder of the workspace repo at the caller's session branch. */
import { Hono } from "hono";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { DbtProject } from "../../database/workspace-schema";
import {
  deleteWorkingFile,
  listWorkingFiles,
  readWorkingFile,
  renameWorkingFile,
  writeWorkingFile,
} from "../../dbt/dbt-working-tree.service";
import {
  getUserId,
  badRequest,
  serverError,
  publishDbtEvent,
  findProject,
} from "./context";
import { fail } from "../lib/respond";

export const dbtFileRoutes = new Hono();

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function isSafeDbtPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !path.split("/").includes("..") &&
    !path.includes("\\")
  );
}

// File reads/writes address the dbt/ folder of the workspace repo at the
// caller's SESSION branch (apps.md §20): a save is a commit, visible to
// whoever is on that branch — separate branches, separate views, like clones.

dbtFileRoutes.get(
  "/projects/:projectId/files",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const files = await listWorkingFiles(project, getUserId(c));
      return c.json({ success: true, files });
    } catch (error) {
      return serverError(c, error, "Failed to list dbt files");
    }
  },
);

dbtFileRoutes.get(
  "/projects/:projectId/files/:path{.+}",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const path = c.req.param("path") as string;
      const file = await readWorkingFile(project, getUserId(c), path);
      if (!file) {
        return fail(c, 404, "File not found");
      }
      return c.json({ success: true, file });
    } catch (error) {
      return serverError(c, error, "Failed to read dbt file");
    }
  },
);

dbtFileRoutes.put(
  "/projects/:projectId/files/:path{.+}",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const path = c.req.param("path") as string;
      if (!isSafeDbtPath(path)) return badRequest(c, "Invalid file path");

      const body = (await c.req.json()) as {
        content?: unknown;
        clientId?: unknown;
      };
      if (typeof body.content !== "string") {
        return badRequest(c, "content (string) is required");
      }
      if (body.content.length > 1_000_000) {
        return badRequest(c, "File too large (max 1MB)");
      }

      const userId = getUserId(c);
      // A save is a commit on the caller's session branch; git history
      // replaces the retired dbt-file entity-version snapshots.
      await writeWorkingFile(project, userId, path, body.content);

      await DbtProject.updateOne(
        { _id: project._id },
        { $currentDate: { updatedAt: true } },
      );
      // A save is a commit: poke the workspace so every open window on the
      // branch refreshes (branch scoping happens at read time).
      publishDbtEvent(c, {
        type: "dbt.file.updated",
        projectId: project._id.toString(),
        path,
        updatedBy: userId,
        clientId: typeof body.clientId === "string" ? body.clientId : undefined,
        origin: "save",
      });
      return c.json({
        success: true,
        file: { path, content: body.content, updatedBy: userId },
      });
    } catch (error) {
      return serverError(c, error, "Failed to save dbt file");
    }
  },
);

dbtFileRoutes.delete(
  "/projects/:projectId/files/:path{.+}",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const path = c.req.param("path") as string;
      const userId = getUserId(c);
      const deleted = await deleteWorkingFile(project, userId, path);
      if (!deleted) {
        return fail(c, 404, "File not found");
      }
      publishDbtEvent(c, {
        type: "dbt.file.updated",
        projectId: project._id.toString(),
        path,
        deleted: true,
        updatedBy: userId,
        origin: "save",
      });
      return c.json({ success: true });
    } catch (error) {
      return serverError(c, error, "Failed to delete dbt file");
    }
  },
);

dbtFileRoutes.post(
  "/projects/:projectId/files/rename",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const body = (await c.req.json()) as {
        from?: unknown;
        to?: unknown;
        clientId?: unknown;
      };
      const from = typeof body.from === "string" ? body.from : "";
      const to = typeof body.to === "string" ? body.to : "";
      if (!isSafeDbtPath(from) || !isSafeDbtPath(to)) {
        return badRequest(c, "Invalid from/to path");
      }
      const userId = getUserId(c);
      const renameError = await renameWorkingFile(project, userId, from, to);
      if (renameError === "File not found") {
        return fail(c, 404, renameError);
      }
      if (renameError) return badRequest(c, renameError);
      // The rename is one commit (delete + add) — poke both paths so open
      // windows move the file.
      const clientId =
        typeof body.clientId === "string" ? body.clientId : undefined;
      publishDbtEvent(c, {
        type: "dbt.file.updated",
        projectId: project._id.toString(),
        path: from,
        deleted: true,
        updatedBy: userId,
        clientId,
        origin: "save",
      });
      publishDbtEvent(c, {
        type: "dbt.file.updated",
        projectId: project._id.toString(),
        path: to,
        updatedBy: userId,
        clientId,
        origin: "save",
      });
      return c.json({ success: true });
    } catch (error) {
      return serverError(c, error, "Failed to rename dbt file");
    }
  },
);
