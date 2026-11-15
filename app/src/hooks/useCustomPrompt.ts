import { useCallback, useEffect } from "react";

import { useWorkspace } from "../contexts/workspace-context";
import {
  DEFAULT_CUSTOM_PROMPT,
  useCustomPromptStore,
} from "../store/customPromptStore";

// Export default content for immediate use
export const customPromptContent = DEFAULT_CUSTOM_PROMPT;

/** The current workspace's custom prompt, loaded on workspace change. State
 * and requests live in `useCustomPromptStore`; this binds them to the
 * active workspace. */
export const useCustomPrompt = () => {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const content = useCustomPromptStore(s => s.content);
  const isLoading = useCustomPromptStore(s => s.isLoading);
  const error = useCustomPromptStore(s => s.error);

  const fetchCustomPrompt = useCallback(async () => {
    if (!workspaceId) {
      useCustomPromptStore.getState().setError("No workspace selected");
      return;
    }
    await useCustomPromptStore.getState().fetchCustomPrompt(workspaceId);
  }, [workspaceId]);

  const updateCustomPrompt = async (newContent: string) => {
    if (!workspaceId) {
      useCustomPromptStore.getState().setError("No workspace selected");
      return false;
    }
    return useCustomPromptStore
      .getState()
      .updateCustomPrompt(workspaceId, newContent);
  };

  const resetCustomPrompt = async () => {
    if (!workspaceId) return false;
    return useCustomPromptStore.getState().resetCustomPrompt(workspaceId);
  };

  useEffect(() => {
    if (workspaceId) {
      void fetchCustomPrompt();
    }
  }, [workspaceId, fetchCustomPrompt]);

  return {
    content,
    isLoading,
    error,
    fetchCustomPrompt,
    updateCustomPrompt,
    resetCustomPrompt,
  };
};
