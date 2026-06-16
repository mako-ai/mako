import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";

/**
 * Unified sharing store for dashboards, consoles and apps.
 *
 * Backs the Google Workspace-style ShareDialog: per-user collaborators
 * (viewer/editor), general access (private/workspace + workspace role) and
 * public links with optional password (dashboards + apps).
 */

export type ShareResourceType = "dashboard" | "console" | "app";
export type ShareRole = "viewer" | "editor";
export type ShareAccess = "private" | "workspace";

export interface ShareCollaborator {
  userId: string;
  role: ShareRole;
  email?: string;
  addedAt?: string;
}

export interface PublicShareInfo {
  enabled: boolean;
  token?: string;
  hasPassword?: boolean;
  createdAt?: string;
}

export interface SharingSettings {
  access: ShareAccess;
  workspaceRole: ShareRole;
}

type Result = { ok: boolean; error?: string };

function basePath(
  type: ShareResourceType,
  workspaceId: string,
  resourceId: string,
): string {
  const segment =
    type === "dashboard"
      ? "dashboards"
      : type === "console"
        ? "consoles"
        : "apps";
  return `/workspaces/${workspaceId}/${segment}/${resourceId}`;
}

export function shareKey(type: ShareResourceType, resourceId: string): string {
  return `${type}:${resourceId}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/**
 * Public share URL: /share/<workspace-slug>/<token>. The workspace segment is
 * cosmetic — the server resolves shares by token alone, so old links and
 * renamed workspaces keep working.
 */
export function buildPublicShareUrl(
  token: string,
  workspaceName?: string,
): string {
  const ws = workspaceName ? slugify(workspaceName) : "";
  return `${window.location.origin}/share/${ws ? `${ws}/` : ""}${token}`;
}

function errMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface ShareStoreState {
  collaborators: Record<string, ShareCollaborator[]>;
  loadingCollaborators: Record<string, boolean>;

  loadCollaborators: (
    type: ShareResourceType,
    workspaceId: string,
    resourceId: string,
  ) => Promise<Result>;
  addCollaborator: (
    type: ShareResourceType,
    workspaceId: string,
    resourceId: string,
    userId: string,
    role: ShareRole,
  ) => Promise<Result>;
  updateCollaboratorRole: (
    type: ShareResourceType,
    workspaceId: string,
    resourceId: string,
    userId: string,
    role: ShareRole,
  ) => Promise<Result>;
  removeCollaborator: (
    type: ShareResourceType,
    workspaceId: string,
    resourceId: string,
    userId: string,
  ) => Promise<Result>;
  updateSharingSettings: (
    type: ShareResourceType,
    workspaceId: string,
    resourceId: string,
    settings: Partial<SharingSettings>,
  ) => Promise<Result & { settings?: SharingSettings }>;
  enablePublicShare: (
    type: ShareResourceType,
    workspaceId: string,
    resourceId: string,
    password?: string,
  ) => Promise<Result & { publicShare?: PublicShareInfo }>;
  updatePublicShare: (
    type: ShareResourceType,
    workspaceId: string,
    resourceId: string,
    changes: {
      password?: string | null;
      rotateToken?: boolean;
      token?: string;
    },
  ) => Promise<Result & { publicShare?: PublicShareInfo }>;
  disablePublicShare: (
    type: ShareResourceType,
    workspaceId: string,
    resourceId: string,
  ) => Promise<Result>;
  /** Owner/admin only: reveal the public link password in plain text. */
  getPublicSharePassword: (
    type: ShareResourceType,
    workspaceId: string,
    resourceId: string,
  ) => Promise<Result & { password?: string | null }>;
}

export const useShareStore = create<ShareStoreState>()(
  immer((set, get) => ({
    collaborators: {},
    loadingCollaborators: {},

    loadCollaborators: async (type, workspaceId, resourceId) => {
      const key = shareKey(type, resourceId);
      set(state => {
        state.loadingCollaborators[key] = true;
      });
      try {
        const response = await apiClient.get<{
          success: boolean;
          data: ShareCollaborator[];
        }>(`${basePath(type, workspaceId, resourceId)}/collaborators`);
        set(state => {
          state.collaborators[key] = response.data ?? [];
          state.loadingCollaborators[key] = false;
        });
        return { ok: true };
      } catch (error) {
        set(state => {
          state.loadingCollaborators[key] = false;
        });
        return {
          ok: false,
          error: errMessage(error, "Failed to load collaborators"),
        };
      }
    },

    addCollaborator: async (type, workspaceId, resourceId, userId, role) => {
      try {
        await apiClient.post(
          `${basePath(type, workspaceId, resourceId)}/collaborators`,
          { userId, role },
        );
        await get().loadCollaborators(type, workspaceId, resourceId);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errMessage(error, "Failed to share") };
      }
    },

    updateCollaboratorRole: async (
      type,
      workspaceId,
      resourceId,
      userId,
      role,
    ) => {
      try {
        await apiClient.patch(
          `${basePath(type, workspaceId, resourceId)}/collaborators/${userId}`,
          { role },
        );
        const key = shareKey(type, resourceId);
        set(state => {
          const list = state.collaborators[key];
          const entry = list?.find(c => c.userId === userId);
          if (entry) entry.role = role;
        });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: errMessage(error, "Failed to update role"),
        };
      }
    },

    removeCollaborator: async (type, workspaceId, resourceId, userId) => {
      try {
        await apiClient.delete(
          `${basePath(type, workspaceId, resourceId)}/collaborators/${userId}`,
        );
        const key = shareKey(type, resourceId);
        set(state => {
          state.collaborators[key] = (state.collaborators[key] ?? []).filter(
            c => c.userId !== userId,
          );
        });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: errMessage(error, "Failed to remove collaborator"),
        };
      }
    },

    updateSharingSettings: async (type, workspaceId, resourceId, settings) => {
      try {
        const response = await apiClient.patch<{
          success: boolean;
          data: SharingSettings;
        }>(`${basePath(type, workspaceId, resourceId)}/sharing`, settings);
        return { ok: true, settings: response.data };
      } catch (error) {
        return {
          ok: false,
          error: errMessage(error, "Failed to update sharing settings"),
        };
      }
    },

    enablePublicShare: async (type, workspaceId, resourceId, password) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          data: PublicShareInfo;
        }>(
          `${basePath(type, workspaceId, resourceId)}/public-share`,
          password ? { password } : {},
        );
        return { ok: true, publicShare: response.data };
      } catch (error) {
        return {
          ok: false,
          error: errMessage(error, "Failed to enable public sharing"),
        };
      }
    },

    updatePublicShare: async (type, workspaceId, resourceId, changes) => {
      try {
        const response = await apiClient.patch<{
          success: boolean;
          data: PublicShareInfo;
        }>(`${basePath(type, workspaceId, resourceId)}/public-share`, changes);
        return { ok: true, publicShare: response.data };
      } catch (error) {
        return {
          ok: false,
          error: errMessage(error, "Failed to update public sharing"),
        };
      }
    },

    disablePublicShare: async (type, workspaceId, resourceId) => {
      try {
        await apiClient.delete(
          `${basePath(type, workspaceId, resourceId)}/public-share`,
        );
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: errMessage(error, "Failed to disable public sharing"),
        };
      }
    },

    getPublicSharePassword: async (type, workspaceId, resourceId) => {
      try {
        const response = await apiClient.get<{
          success: boolean;
          data: { password: string | null };
        }>(`${basePath(type, workspaceId, resourceId)}/public-share/password`);
        return { ok: true, password: response.data?.password ?? null };
      } catch (error) {
        return {
          ok: false,
          error: errMessage(error, "Failed to retrieve password"),
        };
      }
    },
  })),
);
