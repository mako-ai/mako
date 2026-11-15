/**
 * The app list, creating an app, and app folders (real directories in the
 * workspace repo). Static paths: mounted before the `/{id}` routes.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { AppProject } from "../../database/workspace-schema";
import { canWriteResource } from "../../utils/resource-acl";
import { getWorkspaceRepo } from "../../services/workspace-repos.service";
import {
  createProject,
  repoForWorkspace,
  createAppFolder,
  deleteAppFolder,
  folderTargetFromPath,
  moveAppFolder,
  type AppFolderTarget,
} from "../../apps/worktree.service";
import { loadAppsIndex } from "../../apps/app-index.service";
import { appTreeRoot } from "../../apps/app-paths";
import { loadOwnerDirectory } from "../../apps/user-handles.service";
import {
  authorizeFolderTarget,
  canSeeIndexedApp,
} from "../../apps/app-authorization";
import { ensureWorkspaceTemplateSoon } from "../../apps/workspace-template";
import { verifiedAppIds } from "../../apps/app-lifecycle.service";
import { RepoRequiredError } from "../../apps/config";
import { serializePublicShare } from "../lib/public-share-routes";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { timed } from "../../middleware/server-timing";
import {
  WorkspaceParam,
  actingUserId,
  handleError,
  memberRoleFor,
  toProjectJson,
} from "./shared";

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
      const role =
        (c.get("memberRole") as string | undefined) ??
        (await memberRoleFor(workspaceId, userId));

      // The REPO is the list. An app exists because a folder with a
      // `mako.json` exists (anywhere under apps/ or users/<handle>/apps/), so a
      // folder pushed from a local checkout shows up with no registration
      // step (§13). Mongo is consulted only for what cannot live in a repo
      // the customer can clone: visibility, the deployed sha, the share
      // token — and the derived index that makes this read one query.
      // One index read for both (each used to fetch and rev-parse on its own).
      const snapshot = await timed("list.index", () =>
        loadAppsIndex(workspaceId),
      );
      const folders = snapshot.apps.map(app => ({ ...app, id: app.appId }));
      const folderPaths = snapshot.folders;
      // Keep the repo's agent-facing template current for whoever is looking
      // at it (throttled, off the request path — see workspace-template.ts).
      repoForWorkspace(workspaceId)
        .then(repoDir => ensureWorkspaceTemplateSoon(workspaceId, repoDir))
        .catch(() => undefined);
      const [docs, verified] = await Promise.all([
        timed("list.projects", () =>
          AppProject.find({ workspaceId: new Types.ObjectId(workspaceId) })
            .select(
              "_id access workspaceRole sharedWith owner_id createdBy publicShare publishedSha publishedAt chatEnabled",
            )
            .lean(),
        ),
        timed("list.verified", () => verifiedAppIds(workspaceId)),
      ]);
      const stateById = new Map(docs.map(d => [d._id.toString(), d]));

      const apps = folders
        // No record yet means nothing has restricted it — a folder someone
        // pushed is workspace content, visible like any other file in the
        // repo. A folder in someone's personal tree is theirs alone.
        .filter(folder =>
          canSeeIndexedApp(folder, stateById.get(folder.id), userId, role),
        )
        .map(folder => {
          const state = stateById.get(folder.id);
          return {
            id: folder.id,
            slug: folder.slug,
            path: folder.path,
            scope: folder.scope,
            title: folder.title,
            description: folder.description,
            access:
              state?.access ??
              (folder.scope === "private" ? "private" : "workspace"),
            // Who restricted it — the sidebar files a private app someone
            // else shared with you under "Shared with me", not "My Apps".
            owner_id:
              state?.owner_id ??
              (folder.scope === "private" ? folder.ownerId : undefined),
            workspaceRole: state?.workspaceRole,
            // Only safe metadata leaves the API. The password hash and its
            // encrypted reveal copy never do.
            publicShare: serializePublicShare(state?.publicShare),
            publishedSha: state?.publishedSha,
            publishedAt: state?.publishedAt,
            chatEnabled: state?.chatEnabled === true,
            // A copied app that still declares its source's id: the index
            // filed it under its own derived id; the UI offers to stamp one.
            duplicateOf: folder.duplicateOf,
            // A workspace admin vouched for it (app-lifecycle.service.ts).
            verified: folder.scope === "workspace" && verified.has(folder.id),
          };
        });
      // Folders of the two trees the caller can see: the workspace tree, and
      // their own personal tree (never anyone else's) — by the handle
      // mapping, not by what the folder is called.
      const directory = await timed("list.directory", () =>
        loadOwnerDirectory(workspaceId, { forUserId: userId }),
      );
      const handle = directory.handleOf(userId);
      const personalRoot = handle ? appTreeRoot("private", handle) : undefined;
      const visibleFolders = folderPaths.filter(p => {
        if (p.startsWith("apps/")) return true;
        return (
          !!personalRoot &&
          (p === personalRoot || p.startsWith(`${personalRoot}/`))
        );
      });

      return c.json(
        {
          success: true as const,
          apps,
          folders: visibleFolders,
          // Where the caller's own apps go: `users/<handle>/apps`.
          ...(personalRoot ? { personalRoot } : {}),
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
        if (denied) return c.json({ success: false, error: denied }, 403);
      }
      // Apps live in the workspace's own GitHub repo (apps.md §17). Creating
      // one without a connected repo is refused — there is no local-only
      // Cloud Storage skip (issue #956).
      if (!(await getWorkspaceRepo(workspaceId))) {
        return c.json(
          {
            success: false,
            code: "github_required",
            error:
              "Connect a GitHub repository first (Settings → GitHub). Mako keeps your apps and consoles in your own repo.",
          },
          412,
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
      if (denied) return c.json({ success: false, error: denied }, 403);
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
      if (denied) return c.json({ success: false, error: denied }, 403);
      // Moving a folder moves every app in it, and a move into a personal
      // tree re-owns them: the caller must be allowed to write each one, as
      // POST /{id}/move requires for a single app.
      const fromPath = path.replace(/\/+$/, "");
      const inside = (await loadAppsIndex(workspaceId)).apps.filter(
        a => a.path === fromPath || a.path.startsWith(`${fromPath}/`),
      );
      if (inside.length > 0 && userId) {
        const rows = await AppProject.find({
          workspaceId: new Types.ObjectId(workspaceId),
          _id: { $in: inside.map(a => new Types.ObjectId(a.appId)) },
        });
        const refused = rows.find(row => !canWriteResource(row, userId, role));
        if (refused) {
          return c.json(
            {
              success: false,
              error: `You cannot move ${refused.path ?? refused.slug}: it is restricted and not shared with you for editing`,
            },
            403,
          );
        }
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
      if (denied) return c.json({ success: false, error: denied }, 403);
      await deleteAppFolder(workspaceId, target, { userId });
      return c.json({ success: true as const }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);
