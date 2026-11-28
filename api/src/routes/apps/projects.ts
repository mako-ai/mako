/**
 * The app list, creating an app, and app folders (real directories in the
 * workspace repo). Static paths: mounted before the `/{id}` routes.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  firstUnwritableAppIn,
  listVisibleApps,
} from "../../apps/app-listing.service";
import { getWorkspaceRepo } from "../../services/workspace-repos.service";
import {
  createProject,
  createAppFolder,
  deleteAppFolder,
  folderTargetFromPath,
  moveAppFolder,
  type AppFolderTarget,
} from "../../apps/worktree.service";
import { loadOwnerDirectory } from "../../apps/user-handles.service";
import { authorizeFolderTarget } from "../../apps/app-authorization";
import { RepoRequiredError } from "../../apps/config";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import {
  WorkspaceParam,
  actingUserId,
  handleError,
  memberRoleFor,
  toProjectJson,
  callerRole,
} from "./shared";
import { fail } from "../lib/respond";

export const appsProjectRoutes = createRouter();

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

appsProjectRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Apps"],
    summary: "List Apps projects",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const userId = actingUserId(c);
      const role = await callerRole(c, workspaceId, userId);

      const listing = await listVisibleApps(workspaceId, userId, role);
      return c.json(
        {
          success: true as const,
          apps: listing.apps.map(app => ({
            ...app,
            publicShare: app.publicShare ?? { enabled: false },
          })),
          folders: listing.folders,
          // Where the caller's own apps go: `users/<handle>/apps`.
          ...(listing.personalRoot
            ? { personalRoot: listing.personalRoot }
            : {}),
        },
        200,
      );
    } catch (error) {
      // No GitHub binding: the explorer is empty. Writes still 412.
      if (error instanceof RepoRequiredError) {
        return c.json({ success: true as const, apps: [], folders: [] }, 200);
      }
      return handleError(c, error);
    }
  },
);

appsProjectRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Apps"],
    summary: "Create an Apps project",
    description:
      "Creates the project record and its Mako-managed bare git repository seeded with a Vite + React scaffold.",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              title: z.string().min(1),
              description: z.string().optional(),
              /**
               * Folder to create it in: `apps` (default), `apps/Sales/CH`,
               * or `users/<my handle>/apps[/…]` for a personal app.
               */
              folder: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { title, description, folder } = c.req.valid("json");
      const userId = actingUserId(c);
      let target: AppFolderTarget | undefined;
      if (folder) {
        target = folderTargetFromPath(folder);
        const denied = authorizeFolderTarget(
          target,
          userId,
          await memberRoleFor(workspaceId, userId),
          await loadOwnerDirectory(workspaceId, { forUserId: userId }),
        );
        if (denied) return fail(c, 403, denied);
      }
      // Apps live in the workspace's own GitHub repo (apps.md §17). Creating
      // one without a connected repo is refused — there is no local-only
      // Cloud Storage skip (issue #956).
      if (!(await getWorkspaceRepo(workspaceId))) {
        return fail(
          c,
          412,
          "Connect a GitHub repository first (Settings → GitHub). Mako keeps your apps and consoles in your own repo.",
          { code: "github_required" },
        );
      }
      const project = await createProject({
        workspaceId,
        title,
        description,
        userId,
        folder: target,
      });
      return c.json(
        {
          success: true as const,
          app: toProjectJson(project, { title, description }),
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

// ---------------------------------------------------------------------------
// Folders — real directories in the workspace repo, changed with commits.
// Registered before /{id} so "folders" is never read as an app ref.
// ---------------------------------------------------------------------------

const FolderBody = z.object({
  /** `apps/Sales/CH`, or `users/<my handle>/apps/Scratch`. */
  path: z.string().min(1),
});

appsProjectRoutes.openapi(
  createRoute({
    method: "post",
    path: "/folders",
    tags: ["Apps"],
    summary: "Create an empty app folder",
    description:
      "Commits a `.gitkeep` so the folder exists on main. Workspace folders need an editing role; personal folders (`users/<handle>/apps/…`) are the caller's own.",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        required: true,
        content: { "application/json": { schema: FolderBody } },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { path } = c.req.valid("json");
      const userId = actingUserId(c);
      const target = folderTargetFromPath(path);
      const denied = authorizeFolderTarget(
        target,
        userId,
        await memberRoleFor(workspaceId, userId),
        await loadOwnerDirectory(workspaceId, { forUserId: userId }),
      );
      if (denied) return fail(c, 403, denied);
      const created = await createAppFolder(workspaceId, target, { userId });
      return c.json({ success: true as const, folder: created }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsProjectRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/folders",
    tags: ["Apps"],
    summary: "Rename or move an app folder (its apps keep their identity)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              path: z.string().min(1),
              to: z.string().min(1),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { path, to } = c.req.valid("json");
      const userId = actingUserId(c);
      const role = await memberRoleFor(workspaceId, userId);
      const from = folderTargetFromPath(path);
      const target = folderTargetFromPath(to);
      const directory = await loadOwnerDirectory(workspaceId, {
        forUserId: userId,
      });
      const denied =
        authorizeFolderTarget(from, userId, role, directory) ??
        authorizeFolderTarget(target, userId, role, directory);
      if (denied) return fail(c, 403, denied);
      // Moving a folder moves every app in it, and a move into a personal
      // tree re-owns them: the caller must be allowed to write each one, as
      // POST /{id}/move requires for a single app.
      const refused = userId
        ? await firstUnwritableAppIn(workspaceId, path, userId, role)
        : undefined;
      if (refused) {
        return fail(
          c,
          403,
          `You cannot move ${refused.path ?? refused.slug}: it is restricted and not shared with you for editing`,
        );
      }
      const moved = await moveAppFolder(workspaceId, from, target, { userId });
      return c.json({ success: true as const, ...moved }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsProjectRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/folders",
    tags: ["Apps"],
    summary: "Delete an empty app folder",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({
        path: z
          .string()
          .min(1)
          .openapi({ param: { name: "path", in: "query" } }),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { path } = c.req.valid("query");
      const userId = actingUserId(c);
      const target = folderTargetFromPath(path);
      const denied = authorizeFolderTarget(
        target,
        userId,
        await memberRoleFor(workspaceId, userId),
        await loadOwnerDirectory(workspaceId, { forUserId: userId }),
      );
      if (denied) return fail(c, 403, denied);
      await deleteAppFolder(workspaceId, target, { userId });
      return c.json({ success: true as const }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);
