import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from "react";
import {
  workspaceClient,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceInvite,
  type CreateWorkspaceData,
  type InviteMemberData,
} from "../lib/workspace-client";
import { useAuth } from "./auth-context";
import { useUIStore } from "../store/uiStore";
import { useConsoleStore } from "../store/consoleStore";
import { useExplorerStore } from "../store/explorerStore";
import { useChatStore } from "../store/chatStore";

import { useFlowStore } from "../store/flowStore";
import { useSchemaStore } from "../store/schemaStore";
import { useConsoleTreeStore } from "../store/consoleTreeStore";

interface WorkspaceContextState {
  // State
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  members: WorkspaceMember[];
  invites: WorkspaceInvite[];
  loading: boolean;
  initialized: boolean; // true after first load attempt completes
  error: string | null;

  // Actions
  loadWorkspaces: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>; // Reload workspace list without page reload
  createWorkspace: (data: CreateWorkspaceData) => Promise<Workspace>;
  createWorkspaceForOnboarding: (
    data: CreateWorkspaceData,
  ) => Promise<Workspace>; // Create without reload
  updateWorkspace: (
    id: string,
    data: Partial<CreateWorkspaceData>,
  ) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>;

  // Member management
  loadMembers: () => Promise<void>;
  inviteMember: (data: InviteMemberData) => Promise<void>;
  updateMemberRole: (
    userId: string,
    role: "admin" | "member" | "viewer",
  ) => Promise<void>;
  removeMember: (userId: string) => Promise<void>;

  // Invitation management
  loadInvites: () => Promise<void>;
  cancelInvite: (inviteId: string) => Promise<void>;
  acceptInvite: (token: string) => Promise<Workspace>;
}

const WorkspaceContext = createContext<WorkspaceContextState | undefined>(
  undefined,
);

interface WorkspaceProviderProps {
  children: ReactNode;
}

export function WorkspaceProvider({ children }: WorkspaceProviderProps) {
  const { user, loading: authLoading } = useAuth();
  const { currentWorkspaceId, setCurrentWorkspaceId } = useUIStore();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(
    null,
  );
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load workspaces when user is authenticated
  useEffect(() => {
    if (authLoading) return; // wait for auth status to resolve
    if (user) {
      loadWorkspaces();
    } else {
      // Clear in-memory workspace data when user is unauthenticated
      // Preserve persisted workspace id so it can be restored on next login
      setWorkspaces([]);
      setCurrentWorkspace(null);
      setMembers([]);
      setInvites([]);
      // Reset initialized so ProtectedRoute shows loading spinner on next login
      // instead of briefly flashing OnboardingFlow before workspaces load
      setInitialized(false);
    }
  }, [user, authLoading]);

  // Load current workspace data when it changes
  useEffect(() => {
    if (currentWorkspace) {
      loadMembers();
      loadInvites();
    }
  }, [currentWorkspace?.id]);

  // Background preload schema data (connections and databases) when workspace changes
  useEffect(() => {
    if (currentWorkspace?.id) {
      // Trigger background preloading - this loads connections first, then tree roots
      useSchemaStore
        .getState()
        .preloadConnectionsAndDatabases(currentWorkspace.id);
    }
  }, [currentWorkspace?.id]);

  // Background preload console tree when workspace changes
  // This ensures the tree is ready before any optimistic addConsole calls
  useEffect(() => {
    if (currentWorkspace?.id) {
      useConsoleTreeStore.getState().fetchTree(currentWorkspace.id);
    }
  }, [currentWorkspace?.id]);

  const loadWorkspaces = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const workspaceList = await workspaceClient.listWorkspaces();
      setWorkspaces(workspaceList);

      // Workspace selection logic:
      // - 0 workspaces: set currentWorkspace = null (triggers onboarding)
      // - 1 workspace: auto-select it
      // - 2+ workspaces: check localStorage, if not found set null (triggers selector)

      if (workspaceList.length === 0) {
        // No workspaces - will trigger onboarding
        setCurrentWorkspace(null);
        localStorage.removeItem("activeWorkspaceId");
      } else if (workspaceList.length === 1) {
        // Exactly one workspace - auto-select it
        const workspace = workspaceList[0];
        setCurrentWorkspace(workspace);
        setCurrentWorkspaceId(workspace.id);
        localStorage.setItem("activeWorkspaceId", workspace.id);

        // Sync with backend
        try {
          await workspaceClient.switchWorkspace(workspace.id);
        } catch {
          // Ignore switch errors for auto-selection
        }
      } else {
        // Multiple workspaces - check for persisted selection
        const persistedId =
          currentWorkspaceId || localStorage.getItem("activeWorkspaceId");
        const persisted = persistedId
          ? workspaceList.find(ws => ws.id === persistedId)
          : undefined;

        if (persisted) {
          // Valid persisted workspace - use it
          setCurrentWorkspace(persisted);
          setCurrentWorkspaceId(persisted.id);

          // Sync with backend
          try {
            await workspaceClient.switchWorkspace(persisted.id);
          } catch {
            // Ignore switch errors
          }
        } else {
          // No valid persisted workspace - show selector
          setCurrentWorkspace(null);
          localStorage.removeItem("activeWorkspaceId");
        }
      }
    } catch (err: any) {
      setError(err.message || "Failed to load workspaces");
      console.error("Load workspaces error:", err);
    } finally {
      setLoading(false);
      setInitialized(true);
    }
  }, [currentWorkspaceId, setCurrentWorkspaceId]);

  // Refresh workspace list without triggering page reload
  const refreshWorkspaces = useCallback(async () => {
    try {
      const workspaceList = await workspaceClient.listWorkspaces();
      setWorkspaces(workspaceList);

      // If we have a current workspace, ensure it's still in the list
      if (currentWorkspace) {
        const stillExists = workspaceList.find(
          ws => ws.id === currentWorkspace.id,
        );
        if (!stillExists) {
          setCurrentWorkspace(null);
        }
      }
    } catch (err: any) {
      console.error("Refresh workspaces error:", err);
    }
  }, [currentWorkspace]);

  const createWorkspace = useCallback(
    async (data: CreateWorkspaceData): Promise<Workspace> => {
      try {
        setError(null);
        const workspace = await workspaceClient.createWorkspace(data);
        setWorkspaces(prev => [...prev, workspace]);
        // Automatically switch to new workspace
        await switchWorkspace(workspace.id);
        return workspace;
      } catch (err: any) {
        setError(err.message || "Failed to create workspace");
        throw err;
      }
    },
    [],
  );

  // Create workspace during onboarding without triggering page reload
  // This allows the multi-step onboarding flow to continue
  const createWorkspaceForOnboarding = useCallback(
    async (data: CreateWorkspaceData): Promise<Workspace> => {
      try {
        setError(null);
        const workspace = await workspaceClient.createWorkspace(data);
        setWorkspaces(prev => [...prev, workspace]);

        // Set as current workspace WITHOUT reloading
        setCurrentWorkspace(workspace);
        setCurrentWorkspaceId(workspace.id);
        localStorage.setItem("activeWorkspaceId", workspace.id);

        // Sync with backend (don't await to avoid blocking)
        workspaceClient.switchWorkspace(workspace.id).catch(() => {
          // Ignore errors during background sync
        });

        return workspace;
      } catch (err: any) {
        setError(err.message || "Failed to create workspace");
        throw err;
      }
    },
    [setCurrentWorkspaceId],
  );

  const updateWorkspace = useCallback(
    async (id: string, data: Partial<CreateWorkspaceData>) => {
      try {
        setError(null);
        const updated = await workspaceClient.updateWorkspace(id, data);
        setWorkspaces(prev => prev.map(ws => (ws.id === id ? updated : ws)));
        if (currentWorkspace?.id === id) {
          setCurrentWorkspace(updated);
        }
      } catch (err: any) {
        setError(err.message || "Failed to update workspace");
        throw err;
      }
    },
    [currentWorkspace],
  );

  const deleteWorkspace = useCallback(
    async (id: string) => {
      try {
        setError(null);
        await workspaceClient.deleteWorkspace(id);
        setWorkspaces(prev => prev.filter(ws => ws.id !== id));

        // If deleted workspace was current, switch to first available
        if (currentWorkspace?.id === id) {
          const remaining = workspaces.filter(ws => ws.id !== id);
          if (remaining.length > 0) {
            await switchWorkspace(remaining[0].id);
          } else {
            setCurrentWorkspace(null);
            localStorage.removeItem("activeWorkspaceId");
          }
        }
      } catch (err: any) {
        setError(err.message || "Failed to delete workspace");
        throw err;
      }
    },
    [currentWorkspace, workspaces],
  );

  const switchWorkspace = useCallback(
    async (id: string) => {
      try {
        setError(null);
        await workspaceClient.switchWorkspace(id);
        const workspace = workspaces.find(ws => ws.id === id);
        if (workspace) {
          setCurrentWorkspace(workspace);

          // Clear local storage to reset app state for new workspace
          // But preserve the activeWorkspaceId by setting it AFTER clear
          localStorage.clear();
          localStorage.setItem("activeWorkspaceId", id);
          setCurrentWorkspaceId(id);

          // Also reset in-memory store state to prevent leaks if reload is delayed
          useUIStore.getState().reset();
          useExplorerStore.getState().reset();
          useChatStore.getState().reset();
          useConsoleStore.getState().clearAllConsoles();
          useFlowStore.getState().reset();

          // Reload the page to refresh all data with new workspace context
          window.location.reload();
        } else {
          // Workspace not in current list - this can happen during invite acceptance
          // Just set the ID and let the reload fetch the workspace
          localStorage.setItem("activeWorkspaceId", id);
          setCurrentWorkspaceId(id);
          window.location.reload();
        }
      } catch (err: any) {
        setError(err.message || "Failed to switch workspace");
        throw err;
      }
    },
    [workspaces, setCurrentWorkspaceId],
  );

  const loadMembers = useCallback(async () => {
    if (!currentWorkspace) return;

    try {
      const memberList = await workspaceClient.getMembers(currentWorkspace.id);
      setMembers(memberList);
    } catch (err: any) {
      console.error("Load members error:", err);
    }
  }, [currentWorkspace]);

  const inviteMember = useCallback(
    async (data: InviteMemberData) => {
      if (!currentWorkspace) throw new Error("No workspace selected");

      try {
        setError(null);
        const invite = await workspaceClient.createInvite(
          currentWorkspace.id,
          data,
        );
        setInvites(prev => [...prev, invite]);
      } catch (err: any) {
        setError(err.message || "Failed to invite member");
        throw err;
      }
    },
    [currentWorkspace],
  );

  const updateMemberRole = useCallback(
    async (userId: string, role: "admin" | "member" | "viewer") => {
      if (!currentWorkspace) throw new Error("No workspace selected");

      try {
        setError(null);
        const updated = await workspaceClient.updateMemberRole(
          currentWorkspace.id,
          userId,
          { role },
        );
        setMembers(prev =>
          prev.map(member => (member.userId === userId ? updated : member)),
        );
      } catch (err: any) {
        setError(err.message || "Failed to update member role");
        throw err;
      }
    },
    [currentWorkspace],
  );

  const removeMember = useCallback(
    async (userId: string) => {
      if (!currentWorkspace) throw new Error("No workspace selected");

      try {
        setError(null);
        await workspaceClient.removeMember(currentWorkspace.id, userId);
        setMembers(prev => prev.filter(member => member.userId !== userId));
      } catch (err: any) {
        setError(err.message || "Failed to remove member");
        throw err;
      }
    },
    [currentWorkspace],
  );

  const loadInvites = useCallback(async () => {
    if (!currentWorkspace) return;

    try {
      const inviteList = await workspaceClient.getPendingInvites(
        currentWorkspace.id,
      );
      setInvites(inviteList);
    } catch (err: any) {
      console.error("Load invites error:", err);
    }
  }, [currentWorkspace]);

  const cancelInvite = useCallback(
    async (inviteId: string) => {
      if (!currentWorkspace) throw new Error("No workspace selected");

      try {
        setError(null);
        await workspaceClient.cancelInvite(currentWorkspace.id, inviteId);
        setInvites(prev => prev.filter(invite => invite.id !== inviteId));
      } catch (err: any) {
        setError(err.message || "Failed to cancel invite");
        throw err;
      }
    },
    [currentWorkspace],
  );

  const acceptInvite = useCallback(
    async (token: string) => {
      try {
        setError(null);
        const workspace = await workspaceClient.acceptInvite(token);

        // Set localStorage FIRST to ensure the invited workspace is selected after redirect
        // This prevents the race condition where loadWorkspaces() picks a different workspace
        localStorage.setItem("activeWorkspaceId", workspace.id);

        // Add workspace to local list and set as current
        setWorkspaces(prev => {
          // Check if workspace already exists in list
          if (prev.some(ws => ws.id === workspace.id)) {
            return prev;
          }
          return [...prev, workspace];
        });

        // Switch to the accepted workspace on the backend
        await workspaceClient.switchWorkspace(workspace.id);
        setCurrentWorkspace(workspace);
        setCurrentWorkspaceId(workspace.id);

        // Don't reload here - let the calling component (AcceptInvite) handle the redirect
        // after showing the success message

        return workspace;
      } catch (err: any) {
        setError(err.message || "Failed to accept invite");
        throw err;
      }
    },
    [setCurrentWorkspaceId],
  );

  const value: WorkspaceContextState = {
    // State
    workspaces,
    currentWorkspace,
    members,
    invites,
    loading,
    initialized,
    error,

    // Actions
    loadWorkspaces,
    refreshWorkspaces,
    createWorkspace,
    createWorkspaceForOnboarding,
    updateWorkspace,
    deleteWorkspace,
    switchWorkspace,

    // Member management
    loadMembers,
    inviteMember,
    updateMemberRole,
    removeMember,

    // Invitation management
    loadInvites,
    cancelInvite,
    acceptInvite,
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (context === undefined) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return context;
}
