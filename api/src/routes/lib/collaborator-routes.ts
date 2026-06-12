/**
 * Generic per-user collaborator routes shared by dashboards, consoles and
 * apps (Google Workspace-style "share with people" model).
 *
 * Mounts on an existing workspace-scoped router (auth + membership are
 * enforced by the host router's middleware):
 *
 *   GET    /:id/collaborators            — list (anyone with read access)
 *   POST   /:id/collaborators            — add { userId, role? } (owner/admin)
 *   PATCH  /:id/collaborators/:userId    — change role (owner/admin)
 *   DELETE /:id/collaborators/:userId    — remove (owner/admin)
 */

import type { Hono } from "hono";
import type { Document } from "mongoose";
import { loggers } from "../../logging";
import { workspaceService } from "../../services/workspace.service";
import type { AuthenticatedContext } from "../../middleware/workspace.middleware";
import type {
  IResourceShareEntry,
  ResourceShareRole,
} from "../../database/workspace-schema";
import {
  canManageSharing,
  canReadResource,
  getResourceOwnerId,
  type ShareableResourceLike,
} from "../../utils/resource-acl";

const logger = loggers.api("collaborators");

export type ShareableDocument = Document &
  Omit<ShareableResourceLike, "sharedWith"> & {
    sharedWith?: IResourceShareEntry[];
  };

export interface CollaboratorRouteOptions {
  /** Used in log + error messages, e.g. "dashboard". */
  resourceName: string;
  /**
   * Load the resource by `c.req.param("id")`, scoped to the workspace.
   * Return `null` when not found / invalid id.
   */
  load: (c: AuthenticatedContext) => Promise<ShareableDocument | null>;
}

function parseRole(value: unknown): ResourceShareRole {
  return value === "viewer" ? "viewer" : "editor";
}

/**
 * Uniform "general access" settings route:
 *
 *   PATCH /:id/sharing — { access?: "private"|"workspace",
 *                          workspaceRole?: "viewer"|"editor" } (owner/admin)
 *
 * Gives the unified Share dialog one consistent endpoint across dashboards,
 * consoles and apps.
 */
export function registerSharingSettingsRoutes(
  app: Hono,
  options: CollaboratorRouteOptions,
): void {
  const { resourceName, load } = options;

  app.patch("/:id/sharing", async (c: AuthenticatedContext) => {
    try {
      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const doc = await load(c);
      if (!doc) {
        return c.json(
          { success: false, error: `${resourceName} not found` },
          404,
        );
      }
      const memberRole = c.get("memberRole");
      if (!canManageSharing(doc, userId, memberRole)) {
        return c.json(
          {
            success: false,
            error: "Only the owner or an admin can change sharing settings",
          },
          403,
        );
      }

      const body = await c.req.json().catch(() => ({}));
      const access = body?.access;
      const workspaceRole = body?.workspaceRole;

      if (access === "private" || access === "workspace") {
        (doc as any).access = access;
        // Consoles keep a deprecated isPrivate mirror; harmless elsewhere
        // (mongoose strict mode drops unknown paths).
        (doc as any).isPrivate = access === "private";
      }
      if (workspaceRole === "viewer" || workspaceRole === "editor") {
        (doc as any).workspaceRole = workspaceRole;
      }
      await doc.save();

      return c.json({
        success: true,
        data: {
          access: (doc as any).access,
          workspaceRole: (doc as any).workspaceRole ?? "viewer",
        },
      });
    } catch (error) {
      logger.error(`Error updating ${resourceName} sharing settings`, {
        error,
      });
      return c.json(
        { success: false, error: "Failed to update sharing settings" },
        500,
      );
    }
  });
}

export function registerCollaboratorRoutes(
  app: Hono,
  options: CollaboratorRouteOptions,
): void {
  const { resourceName, load } = options;

  app.get("/:id/collaborators", async (c: AuthenticatedContext) => {
    try {
      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const doc = await load(c);
      if (!doc) {
        return c.json(
          { success: false, error: `${resourceName} not found` },
          404,
        );
      }
      const memberRole = c.get("memberRole");
      if (!canReadResource(doc, userId, memberRole)) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const workspaceId = c.req.param("workspaceId");
      const members = await workspaceService.getMembers(workspaceId);
      const emailByUserId = new Map<string, string>(
        members.map((m: any) => [
          (m.userId?._id || m.userId)?.toString(),
          m.userId?.email || "",
        ]),
      );

      const collaborators = (doc.sharedWith || []).map(s => ({
        userId: s.userId,
        role: s.role,
        email: emailByUserId.get(s.userId) || "",
        addedAt: s.addedAt,
      }));

      return c.json({ success: true, data: collaborators });
    } catch (error) {
      logger.error(`Error listing ${resourceName} collaborators`, { error });
      return c.json(
        { success: false, error: "Failed to list collaborators" },
        500,
      );
    }
  });

  app.post("/:id/collaborators", async (c: AuthenticatedContext) => {
    try {
      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const doc = await load(c);
      if (!doc) {
        return c.json(
          { success: false, error: `${resourceName} not found` },
          404,
        );
      }
      const memberRole = c.get("memberRole");
      if (!canManageSharing(doc, userId, memberRole)) {
        return c.json(
          { success: false, error: "Only the owner or an admin can share" },
          403,
        );
      }

      const body = await c.req.json().catch(() => ({}));
      const targetUserId = String(body?.userId || "").trim();
      const role = parseRole(body?.role);
      if (!targetUserId) {
        return c.json({ success: false, error: "userId is required" }, 400);
      }

      if (getResourceOwnerId(doc) === targetUserId) {
        return c.json(
          { success: false, error: "Owner already has full access" },
          400,
        );
      }

      const workspaceId = c.req.param("workspaceId");
      const members = await workspaceService.getMembers(workspaceId);
      const isMember = members.some(
        (m: any) => (m.userId?._id || m.userId)?.toString() === targetUserId,
      );
      if (!isMember) {
        return c.json(
          { success: false, error: "User is not a member of this workspace" },
          400,
        );
      }

      const existing = (doc.sharedWith || []).find(
        s => s.userId === targetUserId,
      );
      if (existing) {
        if (existing.role !== role) {
          existing.role = role;
          doc.markModified("sharedWith");
          await doc.save();
        }
      } else {
        doc.sharedWith = [
          ...(doc.sharedWith || []),
          {
            userId: targetUserId,
            role,
            addedAt: new Date(),
            addedBy: userId,
          },
        ];
        await doc.save();
      }

      return c.json({ success: true, data: doc.sharedWith });
    } catch (error) {
      logger.error(`Error adding ${resourceName} collaborator`, { error });
      return c.json(
        { success: false, error: "Failed to add collaborator" },
        500,
      );
    }
  });

  app.patch("/:id/collaborators/:userId", async (c: AuthenticatedContext) => {
    try {
      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const doc = await load(c);
      if (!doc) {
        return c.json(
          { success: false, error: `${resourceName} not found` },
          404,
        );
      }
      const memberRole = c.get("memberRole");
      if (!canManageSharing(doc, userId, memberRole)) {
        return c.json(
          { success: false, error: "Only the owner or an admin can share" },
          403,
        );
      }

      const targetUserId = c.req.param("userId");
      const body = await c.req.json().catch(() => ({}));
      const role = parseRole(body?.role);

      const entry = (doc.sharedWith || []).find(s => s.userId === targetUserId);
      if (!entry) {
        return c.json({ success: false, error: "Collaborator not found" }, 404);
      }
      if (entry.role !== role) {
        entry.role = role;
        doc.markModified("sharedWith");
        await doc.save();
      }

      return c.json({ success: true, data: doc.sharedWith });
    } catch (error) {
      logger.error(`Error updating ${resourceName} collaborator`, { error });
      return c.json(
        { success: false, error: "Failed to update collaborator" },
        500,
      );
    }
  });

  app.delete("/:id/collaborators/:userId", async (c: AuthenticatedContext) => {
    try {
      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const doc = await load(c);
      if (!doc) {
        return c.json(
          { success: false, error: `${resourceName} not found` },
          404,
        );
      }
      const memberRole = c.get("memberRole");
      if (!canManageSharing(doc, userId, memberRole)) {
        return c.json(
          { success: false, error: "Only the owner or an admin can share" },
          403,
        );
      }

      const targetUserId = c.req.param("userId");
      doc.sharedWith = (doc.sharedWith || []).filter(
        s => s.userId !== targetUserId,
      );
      await doc.save();

      return c.json({ success: true, data: doc.sharedWith });
    } catch (error) {
      logger.error(`Error removing ${resourceName} collaborator`, { error });
      return c.json(
        { success: false, error: "Failed to remove collaborator" },
        500,
      );
    }
  });
}
