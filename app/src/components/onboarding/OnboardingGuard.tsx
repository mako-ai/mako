import React, { useCallback, useState } from "react";
import { CircularProgress, Box } from "@mui/material";
import { useWorkspace } from "../../contexts/workspace-context";
import { useOnboardingState } from "../../hooks/useOnboardingState";
import { OnboardingFlow } from "../OnboardingFlow";
import { WorkspaceSelector } from "../WorkspaceSelector";

/**
 * Props for OnboardingGuard component
 */
interface OnboardingGuardProps {
  children: React.ReactNode;
}

/**
 * Guard component that handles onboarding flow and workspace selection.
 *
 * This component encapsulates all onboarding-related logic:
 * - Shows OnboardingFlow if user has no workspaces
 * - Shows OnboardingFlow if user is in the middle of onboarding (resumed after refresh)
 * - Shows WorkspaceSelector if user has multiple workspaces and no current selection
 * - Shows children when workspace is ready
 *
 * Separates onboarding concerns from authentication concerns (handled by ProtectedRoute).
 */
export function OnboardingGuard({ children }: OnboardingGuardProps) {
  const {
    workspaces,
    currentWorkspace,
    loading: workspaceLoading,
    initialized: workspaceInitialized,
    loadWorkspaces,
  } = useWorkspace();

  const { isInProgress: onboardingInProgress, completeOnboarding } =
    useOnboardingState();

  // Track if user wants to create a new workspace from the selector
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);

  // Handler for when onboarding is complete
  const handleOnboardingComplete = useCallback(() => {
    // Clear onboarding state and reload workspaces
    completeOnboarding();
    setShowCreateWorkspace(false);
    loadWorkspaces();
  }, [completeOnboarding, loadWorkspaces]);

  // Handler for when user wants to create a new workspace from the selector
  const handleCreateNewFromSelector = useCallback(() => {
    setShowCreateWorkspace(true);
  }, []);

  // Show loading spinner while loading workspaces or waiting for initial load
  if (!workspaceInitialized || workspaceLoading) {
    return (
      <Box
        display="flex"
        justifyContent="center"
        alignItems="center"
        minHeight="100vh"
      >
        <CircularProgress size={60} />
      </Box>
    );
  }

  // Show onboarding if:
  // 1. User has no workspaces
  // 2. User clicked "Create New" from selector
  // 3. Onboarding is in progress (user refreshed during multi-step onboarding)
  if (workspaces.length === 0 || showCreateWorkspace || onboardingInProgress) {
    return <OnboardingFlow onComplete={handleOnboardingComplete} />;
  }

  // Show workspace selector if user has 2+ workspaces and no current selection
  if (workspaces.length >= 2 && !currentWorkspace) {
    return (
      <WorkspaceSelector
        workspaces={workspaces}
        onCreateNew={handleCreateNewFromSelector}
      />
    );
  }

  // Still loading if user has 1 workspace but no currentWorkspace yet (auto-selection in progress)
  if (workspaces.length === 1 && !currentWorkspace) {
    return (
      <Box
        display="flex"
        justifyContent="center"
        alignItems="center"
        minHeight="100vh"
      >
        <CircularProgress size={60} />
      </Box>
    );
  }

  // Render children if workspace is ready
  return <>{children}</>;
}
