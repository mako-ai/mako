import React, { useCallback } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/auth-context";
import { useWorkspace } from "../contexts/workspace-context";
import { CircularProgress, Box } from "@mui/material";
import { OnboardingFlow } from "./OnboardingFlow";

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
 */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading: authLoading } = useAuth();
  const {
    workspaces,
    currentWorkspace,
    loading: workspaceLoading,
    loadWorkspaces,
  } = useWorkspace();
  const location = useLocation();

  // Handler for when onboarding is complete
  const handleOnboardingComplete = useCallback(() => {
    // Reload workspaces to get the new/joined workspace
    loadWorkspaces();
  }, [loadWorkspaces]);

  // Show loading spinner while checking auth status
  if (authLoading) {
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

  // Show loading spinner while loading workspaces
  if (workspaceLoading) {
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

  // Show onboarding if user has no workspaces
  if (workspaces.length === 0 && !currentWorkspace) {
    return <OnboardingFlow onComplete={handleOnboardingComplete} />;
  }

  // Render children if authenticated and has workspace
  return <>{children}</>;
}
