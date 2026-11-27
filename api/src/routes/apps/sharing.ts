/**
 * Sharing: access scope, collaborators, sharing settings, public links, and
 * chat with a published app (my chats, on / off).
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Chat, type IAppProject } from "../../database/workspace-schema";
import { appsMetadataRepo } from "../../repositories/apps-metadata";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { canManageSharing } from "../../utils/resource-acl";
import {
  ensureProjectRow,
  resolveProjectRef,
} from "../../apps/worktree.service";
import { registerPublicShareRoutes } from "../lib/public-share-routes";
import {
  registerCollaboratorRoutes,
  registerSharingSettingsRoutes,
} from "../lib/collaborator-routes";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import {
  ProjectParam,
  actingUserId,
  handleError,
  loadProject,
  memberRoleFor,
} from "./shared";
import { fail } from "../lib/respond";

export const appsSharingRoutes = createRouter();

appsSharingRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/access",
    tags: ["Apps"],
    summary: "Set an app's sharing scope (My Apps <-> Workspace)",
    description:
      "The v1 rail's drag-between-sections, for v2: private = the owner's own list, workspace = everyone's. Folder-only apps get their row here (restricting is one of the three row-creating acts, §13.6).",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({ access: z.enum(["private", "workspace"]) }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { access } = c.req.valid("json");
      const userId = loaded.userId;
      const role = await memberRoleFor(
        loaded.project.workspaceId.toString(),
        userId,
      );
      // Same gate as v1: the owner always; a workspace admin only for
      // non-private apps (admins must not discover-or-toggle private ones).
      if (!canManageSharing(loaded.project, userId, role)) {
        return fail(
          c,
          403,
          "Only the owner (or an admin, for workspace apps) can change sharing",
        );
      }
      const project = await ensureProjectRow(
        loaded.project,
        userId ?? "api-key",
      );
      await appsMetadataRepo.updateProjectSharing(
        project.workspaceId.toString(),
        project._id.toString(),
        { access },
      );
      return c.json({ success: true as const, access }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsSharingRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/chats",
    tags: ["Apps"],
    summary: "List my chats with a published app",
    description:
      'The caller\'s own "chat with app" conversations about this app, newest first (without messages — load one through the chats API). Read access to the app is enough: these are the chats its live-link viewers have with it.',
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      if (!loaded.userId) {
        return fail(c, 403, "Sign in to chat");
      }
      const chats = await Chat.find(
        {
          workspaceId: loaded.project.workspaceId,
          appId: loaded.project._id.toString(),
          createdBy: loaded.userId,
        },
        { title: 1, updatedAt: 1, createdAt: 1, activeStreamId: 1 },
      )
        .sort({ updatedAt: -1 })
        .limit(50)
        .lean();
      return c.json(
        {
          success: true as const,
          chats: chats.map(chat => ({
            id: chat._id.toString(),
            title: chat.title,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            streaming: !!chat.activeStreamId,
          })),
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

// Sharing — the SAME primitive consoles use, all three
// surfaces of it: per-user collaborators (viewer/editor), general access
// (private/workspace + workspace role) and public links (bcrypt password +
// AES copy for reveal, token rotation, owner/admin gate). The v1 rip-out
// (#816) took the collaborator and sharing routes with it and left only the
// public link, so the Share dialog had nothing to talk to for apps. The
// anonymous consumption side lives in routes/public-share.ts.
const loadShareableApp = async (c: AuthenticatedContext) => {
  const id = c.req.param("id");
  const workspaceId = c.req.param("workspaceId") as string;
  if (!id || !workspaceId) return null;
  const ref = id.replace(/^apps\//, "");
  // Sharing is one of the three things that gives an app a database row
  // (§13.6) — a share token and its password hash cannot live in a repo the
  // customer can clone. So if the app exists only as a folder, materialize
  // the row now, with the id the index knows it by so every artifact key
  // stays stable.
  const project = await resolveProjectRef(workspaceId, ref);
  if (!project) return null;
  return ensureProjectRow(project, actingUserId(c) ?? "");
};
registerCollaboratorRoutes(appsSharingRoutes, {
  resourceName: "App",
  load: loadShareableApp,
});
registerSharingSettingsRoutes(appsSharingRoutes, {
  resourceName: "App",
  load: loadShareableApp,
});

// "Chat with app" on/off — beside the other link settings, with the same
// gate: the owner or a workspace admin.
appsSharingRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/chat",
    tags: ["Apps"],
    summary: "Turn chat with a published app on or off",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({ enabled: z.boolean() }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const userId = actingUserId(c);
      if (!userId) {
        return fail(c, 401, "Unauthorized");
      }
      const { enabled } = c.req.valid("json");
      const doc = await loadShareableApp(c);
      if (!doc) {
        return fail(c, 404, "App not found");
      }
      const workspaceId = c.req.param("workspaceId") as string;
      const role = await memberRoleFor(workspaceId, userId);
      if (!canManageSharing(doc, userId, role)) {
        return fail(
          c,
          403,
          "Only the owner or an admin can turn chat on or off",
        );
      }
      doc.chatEnabled = enabled;
      await doc.save();
      return c.json({ success: true as const, chatEnabled: enabled }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);
registerPublicShareRoutes(appsSharingRoutes, {
  resourceName: "App",
  load: loadShareableApp,
  getTitle: doc => (doc as unknown as IAppProject).title,
});
