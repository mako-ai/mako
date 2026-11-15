import { useEffect, type ReactNode } from "react";

import { useAuth } from "./auth-context";
import { useConsoleTreeStore } from "../store/consoleTreeStore";
import { useRealtimeStore } from "../store/realtimeStore";
import { useSchemaStore } from "../store/schemaStore";
import {
  useWorkspaceStore,
  type WorkspaceState,
} from "../store/workspaceStore";

/**
 * Workspace state lives in `useWorkspaceStore` (Zustand — the project rule is
 * stores, not Context). This provider holds no state: it only runs the
 * effects that follow the signed-in user and the active workspace (load the
 * list, members/invites, background preloads, the realtime channel).
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const workspaceId = useWorkspaceStore(s => s.currentWorkspace?.id);

  // Load workspaces once auth resolves; drop them on sign-out (the boot hint
  // is kept so the workspace is restored on the next sign-in).
  useEffect(() => {
    if (authLoading) return;
    if (user) {
      void useWorkspaceStore.getState().loadWorkspaces();
    } else {
      useWorkspaceStore.getState().clearSession();
    }
  }, [user, authLoading]);

  useEffect(() => {
    if (!workspaceId) return;
    const { loadMembers, loadInvites } = useWorkspaceStore.getState();
    void loadMembers();
    void loadInvites();
    // Background preload: connections first, then tree roots.
    useSchemaStore.getState().preloadConnectionsAndDatabases(workspaceId);
    // The console tree must be ready before any optimistic addConsole call.
    useConsoleTreeStore.getState().fetchTree(workspaceId);
  }, [workspaceId]);

  // Workspace realtime channel: keeps open console tabs live (other users,
  // other tabs, server-side agent edits) and carries chat activity/intents.
  useEffect(() => {
    if (!workspaceId) return;
    useRealtimeStore.getState().setCurrentUserId(user?.id ?? null);
    useRealtimeStore.getState().connect(workspaceId);
    return () => {
      useRealtimeStore.getState().disconnect();
    };
  }, [workspaceId, user?.id]);

  return <>{children}</>;
}

/**
 * The whole workspace store, for the many components written against the
 * old context. Prefer a narrow selector (`useWorkspaceStore(s => ...)`) in
 * new code: this re-renders on every workspace-store change, as the context
 * did.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useWorkspace(): WorkspaceState {
  return useWorkspaceStore();
}

/**
 * Kept for shared components that also render outside the shell (the app
 * viewer's chat). With the store there is no "outside": it always returns
 * the store, whose `currentWorkspace` is null until the shell loads one.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalWorkspace(): WorkspaceState | undefined {
  return useWorkspaceStore();
}
