import React, { useCallback, useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/auth-context";
import { useWorkspace } from "../contexts/workspace-context";
import { CircularProgress, Box } from "@mui/material";
import { OnboardingFlow } from "./OnboardingFlow";
import { WorkspaceSelector } from "./WorkspaceSelector";
import { getAndClearInviteRedirect } from "../utils/invite-redirect";

/**
 * Props for ProtectedRoute component
 */
interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * Component to protect routes that require authentication.
 * Redirects to /login if not authenticated.
 * Shows onboarding if user has no workspaces.
 * Shows workspace selector if user has 2+ workspaces and no current selection.
 */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading: authLoading } = useAuth();
  const {
    workspaces,
    currentWorkspace,
    loading: workspaceLoading,
    initialized: workspaceInitialized,
    loadWorkspaces,
  } = useWorkspace();
  const location = useLocation();
  const [checkingRedirect, setCheckingRedirect] = useState(true);
  // Track if user wants to create a new workspace from the selector
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);

  // Check for invite redirect after OAuth login
  // This handles the case where user logs in via OAuth and should be redirected to an invite page
  useEffect(() => {
    // Wait until auth loading is complete before checking for redirects
    if (authLoading) {
      return;
    }

    if (user) {
      const inviteRedirect = getAndClearInviteRedirect();
      if (inviteRedirect) {
        // Redirect to the stored invite URL
        window.location.href = inviteRedirect;
        return;
      }
    }

    // Only mark redirect check complete after auth is done
    setCheckingRedirect(false);
  }, [authLoading, user]);

  // Note: Auto-selection of single workspace is handled in loadWorkspaces()
  // in workspace-context.tsx, not here (to avoid triggering reload loops)

  // Handler for when onboarding is complete
  const handleOnboardingComplete = useCallback(() => {
    // Reload workspaces to get the new/joined workspace
    setShowCreateWorkspace(false);
    loadWorkspaces();
  }, [loadWorkspaces]);

  // Handler for when user wants to create a new workspace from the selector
  const handleCreateNewFromSelector = useCallback(() => {
    setShowCreateWorkspace(true);
  }, []);

  // Show loading spinner while checking auth status or redirect
  if (authLoading || checkingRedirect) {
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

  // Redirect to login if not authenticated
  if (!user) {
    // Store the attempted URL for potential redirect after login
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

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

  // Check if onboarding is in progress (user created workspace but hasn't completed flow)
  const onboardingInProgress =
    localStorage.getItem("onboarding_in_progress") === "true";

  // Show onboarding if user has no workspaces OR if they clicked "Create New" from selector
  // OR if onboarding is in progress (user refreshed during multi-step onboarding)
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

  // Render children if authenticated and has workspace
  return <>{children}</>;
}
