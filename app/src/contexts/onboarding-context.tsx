import React, { createContext, useContext, useState, useCallback } from "react";

const ONBOARDING_IN_PROGRESS_KEY = "onboarding_in_progress";
const ONBOARDING_WORKSPACE_ID_KEY = "onboarding_workspace_id";

interface OnboardingContextValue {
  isInProgress: boolean;
  savedWorkspaceId: string | null;
  startOnboarding: (workspaceId: string) => void;
  completeOnboarding: () => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

/**
 * Provider for shared onboarding state.
 * Wrap your app (or the part that needs onboarding) with this provider.
 * State persists to localStorage for page refresh survival.
 */
export function OnboardingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isInProgress, setIsInProgress] = useState<boolean>(() => {
    return localStorage.getItem(ONBOARDING_IN_PROGRESS_KEY) === "true";
  });

  const [savedWorkspaceId, setSavedWorkspaceId] = useState<string | null>(
    () => {
      return localStorage.getItem(ONBOARDING_WORKSPACE_ID_KEY);
    },
  );

  const startOnboarding = useCallback((workspaceId: string) => {
    localStorage.setItem(ONBOARDING_IN_PROGRESS_KEY, "true");
    localStorage.setItem(ONBOARDING_WORKSPACE_ID_KEY, workspaceId);
    setIsInProgress(true);
    setSavedWorkspaceId(workspaceId);
  }, []);

  const completeOnboarding = useCallback(() => {
    localStorage.removeItem(ONBOARDING_IN_PROGRESS_KEY);
    localStorage.removeItem(ONBOARDING_WORKSPACE_ID_KEY);
    setIsInProgress(false);
    setSavedWorkspaceId(null);
  }, []);

  return (
    <OnboardingContext.Provider
      value={{
        isInProgress,
        savedWorkspaceId,
        startOnboarding,
        completeOnboarding,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

/**
 * Hook to access shared onboarding state.
 * Must be used within an OnboardingProvider.
 */
export function useOnboarding(): OnboardingContextValue {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error("useOnboarding must be used within an OnboardingProvider");
  }
  return context;
}
