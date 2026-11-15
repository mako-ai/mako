/**
 * Workspace store — the one owner of "which workspace is this browser tab
 * working in", plus the workspace list, members and invites.
 *
 * `currentWorkspaceId` is the single source of truth for the active
 * workspace: the API client's `x-workspace-id` header, the console-tab
 * persistence bucket and every component read it from here. It lives in
 * memory, per page, so another browser tab switching workspace cannot
 * re-point this one. `lib/active-workspace` only persists the choice as the
 * boot hint for the next load of this tab (sessionStorage) or a new tab
 * (localStorage).
 *
 * `currentWorkspaceId` is seeded from that hint when the store is created —
 * requests made before the workspace list loads carry it, as they always did.
 * `currentWorkspace` is the loaded object: null, or the workspace whose id is
 * `currentWorkspaceId`.
 */
import { create } from "zustand";

import { api, setWorkspaceIdSource } from "../api/client";
import { toErrorMessage, unwrapBody } from "../api/result";
import {
  forgetWorkspaceId,
  getBootWorkspaceId,
  rememberWorkspaceId,
} from "../lib/active-workspace";
import { useChatStore } from "./chatStore";
import { useExplorerStore } from "./explorerStore";
import { useFlowStore } from "./flowStore";
import { workspaceApi } from "./workspace/workspace-api";
import type {
  CreateWorkspaceData,
  InviteDetails,
  InviteMemberData,
  PendingInvite,
  Workspace,
  WorkspaceAutoJoin,
  WorkspaceInvite,
  WorkspaceMember,
} from "./workspace/types";

export type * from "./workspace/types";

type MemberRole = "admin" | "member" | "viewer";

interface WorkspaceData {
  /** This tab's active workspace id (see the module comment). */
  currentWorkspaceId: string | null;
  currentWorkspace: Workspace | null;
  workspaces: Workspace[];
  members: WorkspaceMember[];
  invites: WorkspaceInvite[];
  loading: boolean;
  /** true after the first load attempt completes */
  initialized: boolean;
  error: string | null;
}

export interface WorkspaceState extends WorkspaceData {
  loadWorkspaces: () => Promise<void>;
  /** Reload the workspace list without a page reload. */
  refreshWorkspaces: () => Promise<void>;
  createWorkspace: (data: CreateWorkspaceData) => Promise<Workspace>;
  /** Create and select a workspace without the post-switch reload. */
  createWorkspaceForOnboarding: (
    data: CreateWorkspaceData,
  ) => Promise<Workspace>;
  updateWorkspace: (
    id: string,
    data: Partial<CreateWorkspaceData>,
  ) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  switchWorkspace: (id: string, workspaceOverride?: Workspace) => Promise<void>;

  loadMembers: () => Promise<void>;
  inviteMember: (data: InviteMemberData) => Promise<void>;
  updateMemberRole: (userId: string, role: MemberRole) => Promise<void>;
  removeMember: (userId: string) => Promise<void>;

  loadInvites: () => Promise<void>;
  cancelInvite: (inviteId: string) => Promise<void>;
  acceptInvite: (token: string) => Promise<Workspace>;

  /** Invite preview for the accept page (public endpoint). */
  getInviteDetails: (token: string) => Promise<InviteDetails>;
  /** Invites addressed to the signed-in user's email (onboarding). */
  getPendingInvitesForUser: () => Promise<PendingInvite[]>;
  getAutoJoin: (workspaceId: string) => Promise<WorkspaceAutoJoin | null>;
  setAutoJoin: (
    workspaceId: string,
    data: WorkspaceAutoJoin,
  ) => Promise<WorkspaceAutoJoin | null>;

  /** Save the onboarding questionnaire answers to the user's profile. */
  saveOnboardingAnswers: (answers: Record<string, unknown>) => Promise<void>;

  /** Drop in-memory workspace data on sign-out. The boot hint is kept so the
   * same workspace is restored on the next sign-in. */
  clearSession: () => void;
}

function requireWorkspaceId(get: () => WorkspaceState): string {
  const id = get().currentWorkspace?.id;
  if (!id) throw new Error("No workspace selected");
  return id;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  /** The only writer of the active workspace. */
  const select = (workspace: Workspace | null) => {
    set({
      currentWorkspace: workspace,
      currentWorkspaceId: workspace?.id ?? null,
    });
    if (workspace) rememberWorkspaceId(workspace.id);
    else forgetWorkspaceId();
  };

  /** Runs `fn`, recording its failure as `error` (and rethrowing). */
  const withError = async <T>(
    fallback: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    set({ error: null });
    try {
      return await fn();
    } catch (err) {
      set({ error: toErrorMessage(err, fallback) });
      throw err;
    }
  };

  return {
    currentWorkspaceId: getBootWorkspaceId(),
    currentWorkspace: null,
    workspaces: [],
    members: [],
    invites: [],
    loading: false,
    initialized: false,
    error: null,

    loadWorkspaces: async () => {
      set({ loading: true, error: null });
      try {
        const workspaceList = await workspaceApi.listWorkspaces();
        set({ workspaces: workspaceList });

        // - 0 workspaces: none selected (triggers onboarding)
        // - 1 workspace: auto-select it
        // - 2+: this tab's last choice if it is still valid, else none
        //   (triggers the selector)
        let selected: Workspace | null = null;
        if (workspaceList.length === 1) {
          selected = workspaceList[0];
        } else if (workspaceList.length > 1) {
          const hintId = get().currentWorkspaceId ?? getBootWorkspaceId();
          selected = workspaceList.find(ws => ws.id === hintId) ?? null;
        }
        select(selected);

        if (selected) {
          // Sync with backend; a failure here must not block the app.
          try {
            await workspaceApi.switchWorkspace(selected.id);
          } catch {
            // Ignore switch errors for auto-selection
          }
        }
      } catch (err) {
        set({ error: toErrorMessage(err, "Failed to load workspaces") });
        console.error("Load workspaces error:", err);
      } finally {
        set({ loading: false, initialized: true });
      }
    },

    refreshWorkspaces: async () => {
      try {
        const workspaceList = await workspaceApi.listWorkspaces();
        set({ workspaces: workspaceList });
        const current = get().currentWorkspace;
        if (current) {
          // Take the fresh object: settings (feature flags, tiers) changed on
          // the server are what a refresh is FOR, and the rail reads them
          // from here.
          const fresh = workspaceList.find(ws => ws.id === current.id) ?? null;
          set({
            currentWorkspace: fresh,
            currentWorkspaceId: fresh?.id ?? null,
          });
        }
      } catch (err) {
        console.error("Refresh workspaces error:", err);
      }
    },

    createWorkspace: data =>
      withError("Failed to create workspace", async () => {
        const workspace = await workspaceApi.createWorkspace(data);
        set(s => ({ workspaces: [...s.workspaces, workspace] }));
        // Pass the object: the list lookup in switchWorkspace must not depend
        // on the `set` above having been observed.
        await get().switchWorkspace(workspace.id, workspace);
        return workspace;
      }),

    createWorkspaceForOnboarding: data =>
      withError("Failed to create workspace", async () => {
        const workspace = await workspaceApi.createWorkspace(data);
        set(s => ({ workspaces: [...s.workspaces, workspace] }));
        // Select WITHOUT reloading so the multi-step onboarding continues.
        select(workspace);
        // Sync with backend (don't await to avoid blocking)
        workspaceApi.switchWorkspace(workspace.id).catch(() => {
          // Ignore errors during background sync
        });
        return workspace;
      }),

    updateWorkspace: (id, data) =>
      withError("Failed to update workspace", async () => {
        const updated = await workspaceApi.updateWorkspace(id, data);
        set(s => ({
          workspaces: s.workspaces.map(ws => (ws.id === id ? updated : ws)),
          ...(s.currentWorkspace?.id === id
            ? { currentWorkspace: updated }
            : {}),
        }));
      }),

    deleteWorkspace: id =>
      withError("Failed to delete workspace", async () => {
        await workspaceApi.deleteWorkspace(id);
        const remaining = get().workspaces.filter(ws => ws.id !== id);
        set({ workspaces: remaining });
        // If the deleted workspace was current, switch to the first left.
        if (get().currentWorkspace?.id === id) {
          if (remaining.length > 0) {
            await get().switchWorkspace(remaining[0].id);
          } else {
            select(null);
          }
        }
      }),

    switchWorkspace: (id, workspaceOverride) =>
      withError("Failed to switch workspace", async () => {
        await workspaceApi.switchWorkspace(id);

        const workspace =
          workspaceOverride ?? get().workspaces.find(ws => ws.id === id);
        if (workspace) {
          select(workspace);
        } else {
          set({ currentWorkspaceId: id });
          rememberWorkspaceId(id);
        }

        // Console tabs are persisted per workspace (`console-store:<id>`, see
        // consoleStore's storage adapter), so they must NOT be cleared here:
        // the post-switch reload rehydrates the new workspace's own tabs, and
        // switching back later restores this workspace's tabs. The adapter
        // freezes writes once `currentWorkspaceId` flips (just above), so the
        // old workspace's tabs can't leak into the new bucket before the
        // reload.
        //
        // Reset only the persisted stores whose state is global and
        // workspace-specific, so it can't leak into the new workspace.
        useExplorerStore.getState().reset();
        useChatStore.getState().reset();
        useFlowStore.getState().reset();

        // Reload from the root: keeping the current path would make UrlSync
        // deep-link the previous workspace's resource (e.g. /a/<appId>) into
        // the new workspace, where it 404s. The new workspace's own active
        // tab is restored from its persisted bucket instead.
        window.location.replace("/");
      }),

    loadMembers: async () => {
      const id = get().currentWorkspace?.id;
      if (!id) return;
      try {
        const members = await workspaceApi.getMembers(id);
        set({ members });
      } catch (err) {
        console.error("Load members error:", err);
      }
    },

    inviteMember: data =>
      withError("Failed to invite member", async () => {
        const invite = await workspaceApi.createInvite(
          requireWorkspaceId(get),
          data,
        );
        set(s => ({ invites: [...s.invites, invite] }));
      }),

    updateMemberRole: (userId, role) =>
      withError("Failed to update member role", async () => {
        const updated = await workspaceApi.updateMemberRole(
          requireWorkspaceId(get),
          userId,
          { role },
        );
        set(s => ({
          members: s.members.map(member =>
            member.userId === userId
              ? {
                  ...member,
                  ...updated,
                  id: updated.id || member.id,
                  userId: updated.userId || member.userId,
                  email: updated.email || member.email,
                  joinedAt: updated.joinedAt || member.joinedAt,
                }
              : member,
          ),
        }));
      }),

    removeMember: userId =>
      withError("Failed to remove member", async () => {
        await workspaceApi.removeMember(requireWorkspaceId(get), userId);
        set(s => ({
          members: s.members.filter(member => member.userId !== userId),
        }));
      }),

    loadInvites: async () => {
      const id = get().currentWorkspace?.id;
      if (!id) return;
      try {
        const invites = await workspaceApi.getPendingInvites(id);
        set({ invites });
      } catch (err) {
        console.error("Load invites error:", err);
      }
    },

    cancelInvite: inviteId =>
      withError("Failed to cancel invite", async () => {
        await workspaceApi.cancelInvite(requireWorkspaceId(get), inviteId);
        set(s => ({
          invites: s.invites.filter(invite => invite.id !== inviteId),
        }));
      }),

    acceptInvite: token =>
      withError("Failed to accept invite", async () => {
        const workspace = await workspaceApi.acceptInvite(token);
        // Remember the invited workspace FIRST so the redirect selects it
        // (loadWorkspaces must not pick a different one).
        rememberWorkspaceId(workspace.id);
        set(s => ({
          workspaces: s.workspaces.some(ws => ws.id === workspace.id)
            ? s.workspaces
            : [...s.workspaces, workspace],
        }));
        await workspaceApi.switchWorkspace(workspace.id);
        select(workspace);
        // No reload here: the caller (AcceptInvite) redirects after showing
        // the success message.
        return workspace;
      }),

    getInviteDetails: token => workspaceApi.getInviteDetails(token),
    getPendingInvitesForUser: () => workspaceApi.getPendingInvitesForUser(),
    getAutoJoin: workspaceId => workspaceApi.getAutoJoin(workspaceId),
    setAutoJoin: (workspaceId, data) =>
      workspaceApi.setAutoJoin(workspaceId, data),

    saveOnboardingAnswers: async answers => {
      unwrapBody(await api.PUT("/api/auth/onboarding", { body: answers }));
    },

    clearSession: () =>
      set({
        workspaces: [],
        currentWorkspace: null,
        members: [],
        invites: [],
        // Reset so ProtectedRoute shows its spinner on the next sign-in
        // instead of briefly flashing onboarding before workspaces load.
        initialized: false,
      }),
  };
});

setWorkspaceIdSource(() => useWorkspaceStore.getState().currentWorkspaceId);

/** Imperative read of this tab's active workspace id, for code outside React
 * (store actions, agent client tools, tab-open shells). Components subscribe
 * with `useWorkspaceStore(s => s.currentWorkspaceId)`. */
export function getCurrentWorkspaceId(): string | null {
  return useWorkspaceStore.getState().currentWorkspaceId;
}
