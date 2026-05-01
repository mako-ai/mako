import { useMemo } from "react";
import { useAuth } from "../contexts/auth-context";
import { useWorkspace } from "../contexts/workspace-context";

/**
 * True when the current user is owner or admin of the active workspace.
 * Uses workspace list role first (always available), then members list if loaded.
 */
export function useIsWorkspaceAdmin(): boolean {
  const { user } = useAuth();
  const { currentWorkspace, members } = useWorkspace();

  return useMemo(() => {
    if (!user?.id || !currentWorkspace) return false;
    const fromWorkspace = currentWorkspace.role;
    if (fromWorkspace === "owner" || fromWorkspace === "admin") {
      return true;
    }
    const me = members.find(m => m.userId === user.id);
    return me?.role === "owner" || me?.role === "admin";
  }, [user?.id, currentWorkspace, members]);
}
