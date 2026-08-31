import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, unwrap } from "../api";

/**
 * Typed base path per resource. Collaborator + sharing endpoints exist for all
 * three resources, so these literal templates resolve to valid spec paths and
 * give the typed client compile-time path/param checking.
 */
const RESOURCE_BASE = {
  dashboard: "/api/workspaces/{workspaceId}/dashboards/{id}",
  console: "/api/workspaces/{workspaceId}/consoles/{id}",
  app: "/api/workspaces/{workspaceId}/apps/{id}",
} as const;

/**
 * Public links are only supported for dashboards and apps (not consoles), so
 * these literal templates resolve to valid spec paths for the typed client.
 */
const PUBLIC_SHARE_BASE = {
  dashboard: "/api/workspaces/{workspaceId}/dashboards/{id}/public-share",
  app: "/api/workspaces/{workspaceId}/apps/{id}/public-share",
} as const;

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
  /** Apps only: viewer may run published live bindings (not just snapshots). */
  allowLiveQueries?: boolean;
}

export interface SharingSettings {
  access: ShareAccess;
  workspaceRole: ShareRole;
}

type Result = { ok: boolean; error?: string };

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

/**
 * Deep-link path prefix per resource — must match TAB_DEEP_LINK_PATTERNS in
 * lib/tab-routing.ts so the copied link hydrates into the right tab.
 */
const RESOURCE_URL_PREFIX: Record<ShareResourceType, string> = {
  dashboard: "d",
  console: "c",
  app: "apps",
};

/**
 * Workspace-internal URL for logged-in collaborators (/a/:id, /d/:id, /c/:id).
 * Built from the resource id rather than read off the address bar so it also
 * works in the desktop shell, which has no address bar to copy from.
 */
export function buildWorkspaceResourceUrl(
  resourceType: ShareResourceType,
  resourceId: string,
): string {
  return `${window.location.origin}/${RESOURCE_URL_PREFIX[resourceType]}/${resourceId}`;
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
      allowLiveQueries?: boolean;
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
        const response = unwrap(
          await api.GET(`${RESOURCE_BASE[type]}/collaborators`, {
            params: { path: { workspaceId, id: resourceId } },
          }),
        ) as { data?: ShareCollaborator[] };
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
        unwrap(
          await api.POST(`${RESOURCE_BASE[type]}/collaborators`, {
            params: { path: { workspaceId, id: resourceId } },
            body: { userId, role },
          }),
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
        unwrap(
          await api.PATCH(`${RESOURCE_BASE[type]}/collaborators/{userId}`, {
            params: { path: { workspaceId, id: resourceId, userId } },
            body: { role },
          }),
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
        unwrap(
          await api.DELETE(`${RESOURCE_BASE[type]}/collaborators/{userId}`, {
            params: { path: { workspaceId, id: resourceId, userId } },
          }),
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
        const response = unwrap(
          await api.PATCH(`${RESOURCE_BASE[type]}/sharing`, {
            params: { path: { workspaceId, id: resourceId } },
            body: settings,
          }),
        ) as { data?: SharingSettings };
        return { ok: true, settings: response.data };
      } catch (error) {
        return {
          ok: false,
          error: errMessage(error, "Failed to update sharing settings"),
        };
      }
    },

    enablePublicShare: async (type, workspaceId, resourceId, password) => {
      if (type === "console") {
        return { ok: false, error: "Public sharing is not supported here" };
      }
      try {
        const response = unwrap(
          await api.POST(PUBLIC_SHARE_BASE[type], {
            params: { path: { workspaceId, id: resourceId } },
            body: password ? { password } : {},
          }),
        ) as { data?: PublicShareInfo };
        return { ok: true, publicShare: response.data };
      } catch (error) {
        return {
          ok: false,
          error: errMessage(error, "Failed to enable public sharing"),
        };
      }
    },

    updatePublicShare: async (type, workspaceId, resourceId, changes) => {
      if (type === "console") {
        return { ok: false, error: "Public sharing is not supported here" };
      }
      try {
        const response = unwrap(
          await api.PATCH(PUBLIC_SHARE_BASE[type], {
            params: { path: { workspaceId, id: resourceId } },
            body: changes,
          }),
        ) as { data?: PublicShareInfo };
        return { ok: true, publicShare: response.data };
      } catch (error) {
        return {
          ok: false,
          error: errMessage(error, "Failed to update public sharing"),
        };
      }
    },

    disablePublicShare: async (type, workspaceId, resourceId) => {
      if (type === "console") {
        return { ok: false, error: "Public sharing is not supported here" };
      }
      try {
        unwrap(
          await api.DELETE(PUBLIC_SHARE_BASE[type], {
            params: { path: { workspaceId, id: resourceId } },
          }),
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
      if (type === "console") {
        return { ok: false, error: "Public sharing is not supported here" };
      }
      try {
        const response = unwrap(
          await api.GET(`${PUBLIC_SHARE_BASE[type]}/password`, {
            params: { path: { workspaceId, id: resourceId } },
          }),
        ) as { data?: { password: string | null } };
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
