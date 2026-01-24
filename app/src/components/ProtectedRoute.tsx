import React, { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/auth-context";
import { CircularProgress, Box } from "@mui/material";
import { OnboardingGuard } from "./onboarding";
import { getAndClearInviteRedirect } from "../utils/invite-redirect";

/**
 * Props for ProtectedRoute component
 */
interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * Component to protect routes that require authentication.
 *
 * Responsibilities:
 * - Redirects to /login if not authenticated
 * - Handles invite redirect after OAuth login
 * - Delegates workspace/onboarding logic to OnboardingGuard
 *
 * This component is now focused solely on authentication concerns.
 * Workspace selection and onboarding are handled by OnboardingGuard.
 */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const [checkingRedirect, setCheckingRedirect] = useState(true);

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

  // User is authenticated - delegate to OnboardingGuard for workspace/onboarding logic
  return <OnboardingGuard>{children}</OnboardingGuard>;
}
