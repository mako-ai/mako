import { useState, useCallback } from "react";

const ONBOARDING_IN_PROGRESS_KEY = "onboarding_in_progress";
const ONBOARDING_WORKSPACE_ID_KEY = "onboarding_workspace_id";

export interface OnboardingState {
  /** Whether onboarding is currently in progress */
  isInProgress: boolean;
  /** The workspace ID created during onboarding (if any) */
  savedWorkspaceId: string | null;
}

export interface UseOnboardingStateReturn extends OnboardingState {
  /** Start onboarding with a workspace ID */
  startOnboarding: (workspaceId: string) => void;
  /** Complete onboarding and clear all state */
  completeOnboarding: () => void;
  /** Reset onboarding state (for testing or error recovery) */
  resetOnboarding: () => void;
}

/**
 * Hook to manage onboarding state using localStorage.
 *
 * This encapsulates the localStorage logic for onboarding persistence,
 * allowing the onboarding flow to resume after page refreshes.
 *
 * @example
 * ```tsx
 * const { isInProgress, savedWorkspaceId, startOnboarding, completeOnboarding } = useOnboardingState();
 *
 * // Start onboarding when workspace is created
 * startOnboarding(workspace.id);
 *
 * // Complete onboarding when flow finishes
 * completeOnboarding();
 * ```
 */
export function useOnboardingState(): UseOnboardingStateReturn {
  // Initialize state from localStorage
  const [isInProgress, setIsInProgress] = useState<boolean>(() => {
    return localStorage.getItem(ONBOARDING_IN_PROGRESS_KEY) === "true";
  });

  const [savedWorkspaceId, setSavedWorkspaceId] = useState<string | null>(
    () => {
      return localStorage.getItem(ONBOARDING_WORKSPACE_ID_KEY);
    },
  );

  /**
   * Start onboarding with a workspace ID.
   * This saves the state to localStorage so it can survive page refreshes.
   */
  const startOnboarding = useCallback((workspaceId: string) => {
    localStorage.setItem(ONBOARDING_IN_PROGRESS_KEY, "true");
    localStorage.setItem(ONBOARDING_WORKSPACE_ID_KEY, workspaceId);
    setIsInProgress(true);
    setSavedWorkspaceId(workspaceId);
  }, []);

  /**
   * Complete onboarding and clear all state.
   * Call this when the user finishes the onboarding flow successfully.
   */
  const completeOnboarding = useCallback(() => {
    localStorage.removeItem(ONBOARDING_IN_PROGRESS_KEY);
    localStorage.removeItem(ONBOARDING_WORKSPACE_ID_KEY);
    setIsInProgress(false);
    setSavedWorkspaceId(null);
  }, []);

  /**
   * Reset onboarding state.
   * Useful for testing or error recovery when you need to clear the state
   * without completing the flow.
   */
  const resetOnboarding = useCallback(() => {
    localStorage.removeItem(ONBOARDING_IN_PROGRESS_KEY);
    localStorage.removeItem(ONBOARDING_WORKSPACE_ID_KEY);
    setIsInProgress(false);
    setSavedWorkspaceId(null);
  }, []);

  return {
    isInProgress,
    savedWorkspaceId,
    startOnboarding,
    completeOnboarding,
    resetOnboarding,
  };
}

/**
 * Check if onboarding should be shown based on current state.
 * This is a helper function that can be used outside of React components.
 */
export function shouldShowOnboarding(
  workspacesCount: number,
  showCreateWorkspace: boolean,
): boolean {
  const isInProgress =
    localStorage.getItem(ONBOARDING_IN_PROGRESS_KEY) === "true";
  return workspacesCount === 0 || showCreateWorkspace || isInProgress;
}
