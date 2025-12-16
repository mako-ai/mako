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
import { useAppStore } from "../store";

import { useFlowStore } from "../store/flowStore";
import { useSchemaStore } from "../store/schemaStore";

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
  createWorkspace: (data: CreateWorkspaceData) => Promise<Workspace>;
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
  const { currentWorkspaceId, setCurrentWorkspaceId } = useAppStore();
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

  const loadWorkspaces = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [workspaceList, current] = await Promise.all([
        workspaceClient.listWorkspaces(),
        workspaceClient.getCurrentWorkspace(),
      ]);

      setWorkspaces(workspaceList);
      // Prefer persisted workspace if available and exists in list
      const persistedId =
        currentWorkspaceId || localStorage.getItem("activeWorkspaceId");
      const persisted = persistedId
        ? workspaceList.find(ws => ws.id === persistedId)
        : undefined;
      if (persisted) {
        // If backend's current workspace differs from persisted, switch it
        if (!current || current.id !== persisted.id) {
          try {
            await workspaceClient.switchWorkspace(persisted.id);
          } catch (switchErr) {
            console.error(
              "Failed to switch workspace to persisted id:",
              switchErr,
            );
          }
        }
        setCurrentWorkspace(persisted);
        setCurrentWorkspaceId(persisted.id);
      } else {
        setCurrentWorkspace(current);
        if (current) setCurrentWorkspaceId(current.id);
      }

      // Store active workspace ID
      const activeId = (persisted && persisted.id) || (current && current.id);
      if (activeId) localStorage.setItem("activeWorkspaceId", activeId);
    } catch (err: any) {
      setError(err.message || "Failed to load workspaces");
      console.error("Load workspaces error:", err);
    } finally {
      setLoading(false);
      setInitialized(true);
    }
  }, []);

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
          localStorage.clear();

          // Also reset in-memory store state to prevent leaks if reload is delayed
          useAppStore.getState().reset();
          useFlowStore.getState().reset();

          localStorage.setItem("activeWorkspaceId", id);
          setCurrentWorkspaceId(id);
          // Reload the page to refresh all data with new workspace context
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
        // Reload workspaces and switch to the accepted workspace
        await loadWorkspaces();
        await switchWorkspace(workspace.id);
        return workspace;
      } catch (err: any) {
        setError(err.message || "Failed to accept invite");
        throw err;
      }
    },
    [loadWorkspaces, switchWorkspace],
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
    createWorkspace,
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
