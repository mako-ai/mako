import { useCallback, useEffect } from "react";
import { useAuth } from "../contexts/auth-context";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppV2Store } from "../store/appV2Store";

export function useAppV2Status() {
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const availability = useAppV2Store(state =>
    workspaceId ? state.availabilityByWorkspace[workspaceId] : undefined,
  );
  const fetchStatusWithRetry = useAppV2Store(
    state => state.fetchStatusWithRetry,
  );

  useEffect(() => {
    if (user && workspaceId) void fetchStatusWithRetry(workspaceId);
  }, [fetchStatusWithRetry, user, workspaceId]);

  const retry = useCallback(() => {
    if (!workspaceId) return Promise.resolve(false);
    return fetchStatusWithRetry(workspaceId);
  }, [fetchStatusWithRetry, workspaceId]);

  return {
    enabled: availability?.enabled === true,
    loading: availability?.loading === true,
    error: availability?.error ?? null,
    retry,
  };
}
